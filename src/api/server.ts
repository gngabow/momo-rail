import http from 'http';
import fs from 'fs';
import path from 'path';
import { bootstrap } from '../config/bootstrap';
import { Ledger } from '../ledger/ledger';
import { PgLedger } from '../ledger/pgLedger';
import { LedgerStore } from '../ledger/store';
import { CountryRegistry } from '../config/countryProfile';
import { ProviderRegistry } from '../providers/registry';
import { getMoMoConfigFromEnv } from '../providers/momoEnv';
import { FixedFxRateProvider } from '../fx/fxRateProvider';
import { RailService } from '../rail/railService';
import { PayrollService } from '../payroll/payrollService';
import { provisionWallet } from '../wallet/walletService';

/**
 * HTTP server (Node's built-in `http`) that puts the tested momo-rail engine
 * behind a small JSON API and serves the wallet portal.
 *
 * Storage is chosen at boot: no DATABASE_URL -> in-memory `Ledger` (the
 * dependency-free demo, resets on restart); DATABASE_URL set -> `PgLedger`
 * (Postgres durability, survives restarts). Everything above the ledger is
 * identical either way.
 */
const providers = new ProviderRegistry({ getMoMoConfig: getMoMoConfigFromEnv });
const fx = new FixedFxRateProvider();

// Assigned during start() once the (possibly async) store is ready.
let ledger: LedgerStore;
let registry: CountryRegistry;
let rail: RailService;
let payroll: PayrollService;
const rates: Record<string, string> = {};

function makeStore(): LedgerStore {
  const url = process.env.DATABASE_URL;
  if (url) { console.log('momo-rail: DATABASE_URL set — using Postgres durability'); return new PgLedger(url); }
  console.log('momo-rail: no DATABASE_URL — using in-memory ledger (resets on restart)');
  return new Ledger();
}

const seeded = new Set<string>();
const activity = new Map<string, { t: number; text: string; cls: string }[]>();
function logAct(cid: string, text: string, cls = '') {
  const a = activity.get(cid) || [];
  a.unshift({ t: Date.now(), text, cls });
  activity.set(cid, a.slice(0, 20));
}

/** Give a new demo customer a starting balance so the portal is usable at once.
 * Idempotency keys make this safe to re-run across restarts on the durable path. */
async function seed(cid: string) {
  if (seeded.has(cid)) return;
  seeded.add(cid);
  const uw = await provisionWallet(ledger, cid, 'USDT', null);
  await ledger.postEntry({ entryType: 'demo_seed', idempotencyKey: `seed-USDT-${cid}`, lines: [{ accountId: 'sys-USDT-hot', amount: '-250' }, { accountId: uw.id, amount: '250' }] });
  const starters: [string, string, string][] = [['UG', 'UGX', '400000'], ['KE', 'KES', '15000']];
  for (const [code, ccy, amt] of starters) {
    const p = registry.get(code);
    const w = await provisionWallet(ledger, cid, ccy, code);
    await ledger.postEntry({ entryType: 'demo_seed', idempotencyKey: `seed-${ccy}-${cid}`, lines: [{ accountId: p.ledgerAccounts.localFloatId, amount: `-${amt}` }, { accountId: w.id, amount: amt }] });
  }
}

async function balances(cid: string, code: string) {
  await seed(cid);
  const p = registry.require(code);
  const lw = await ledger.findCustomerWallet(cid, p.localCurrency);
  const uw = await ledger.findCustomerWallet(cid, 'USDT');
  return {
    country: p.code, name: p.displayName, localCurrency: p.localCurrency, dial: p.dialCode,
    operator: p.momoOperator, rate: rates[p.localCurrency],
    local: lw ? (await ledger.getBalance(lw.id)).balance : '0',
    usdt: uw ? (await ledger.getBalance(uw.id)).balance : '0.000000',
  };
}

function send(res: http.ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

let PORTAL = '';
function portalHtml(): string {
  if (PORTAL) return PORTAL;
  for (const p of [path.join(process.cwd(), 'web', 'index.html'), path.join(__dirname, '..', '..', '..', 'web', 'index.html')]) {
    try { PORTAL = fs.readFileSync(p, 'utf8'); break; } catch { /* try next */ }
  }
  return PORTAL || '<h1>Portal not found</h1>';
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://x');
    const q = u.searchParams;
    const p = u.pathname;

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(portalHtml());
      return;
    }
    if (p === '/health') return send(res, 200, { ok: true, markets: registry.list().length, store: process.env.DATABASE_URL ? 'postgres' : 'memory' });

    if (p === '/api/markets') {
      return send(res, 200, registry.list().map((m) => ({
        code: m.code, name: m.displayName, ccy: m.localCurrency, dial: m.dialCode,
        rate: rates[m.localCurrency], op: m.momoOperator,
        tested: m.licensing.regime.endsWith('pilot'),
      })));
    }
    if (p === '/api/wallet') {
      const cid = String(q.get('customer') || 'demo');
      return send(res, 200, await balances(cid, String(q.get('country') || 'UG')));
    }
    if (p === '/api/activity') {
      const cid = String(q.get('customer') || 'demo');
      return send(res, 200, activity.get(cid) || []);
    }
    if (p === '/api/pending') {
      const cid = String(q.get('customer') || 'demo');
      return send(res, 200, rail.pendingStore().list().filter((x) => x.customerId === cid));
    }

    // MoMo provider callback — MTN posts the terminal state here (X-Callback-Url).
    // Settles the matching in-flight deposit/withdraw exactly once.
    if (p.startsWith('/api/momo/callback/') && req.method === 'POST') {
      const body = await readBody(req);
      const ref = String(body.externalId ?? body.referenceId ?? '');
      const raw = String(body.status ?? '').toUpperCase();
      const status: 'success' | 'failed' | 'pending' = raw === 'SUCCESSFUL' ? 'success' : raw === 'FAILED' ? 'failed' : 'pending';
      if (status === 'pending' || !ref) return send(res, 202, { received: true });
      const item = rail.pendingStore().get(ref);
      const settled = await rail.settle(ref, status, String(body.financialTransactionId ?? ''), body.reason ? String(body.reason) : undefined);
      if (item) {
        const verb = item.kind === 'deposit' ? 'Cash in' : 'Cash out';
        logAct(item.customerId, `${verb} ${status === 'success' ? 'confirmed' : 'failed'} — ${item.amountLocal} ${item.currency}`,
          status === 'success' ? (item.kind === 'deposit' ? 'pos' : 'neg') : 'neg');
      }
      return send(res, 200, { settled: settled?.status ?? 'unknown' });
    }

    // Status poll — asks the operator for a pending reference's state, settles if terminal.
    if (p === '/api/momo/status') {
      const ref = String(q.get('ref') || '');
      const product: 'collection' | 'disbursement' = String(q.get('product') || 'collection') === 'disbursement' ? 'disbursement' : 'collection';
      const item = rail.pendingStore().get(ref);
      if (!item) return send(res, 404, { error: 'unknown reference' });
      const profile = registry.require(item.countryCode);
      const provider = providers.resolve(profile);
      const pr = await provider.status(ref, product);
      if (pr.status !== 'pending') {
        await rail.settle(ref, pr.status as 'success' | 'failed', pr.providerRef);
        logAct(item.customerId, `${item.kind === 'deposit' ? 'Cash in' : 'Cash out'} ${pr.status === 'success' ? 'confirmed' : 'failed'} — ${item.amountLocal} ${item.currency}`,
          pr.status === 'success' ? (item.kind === 'deposit' ? 'pos' : 'neg') : 'neg');
      }
      return send(res, 200, { reference: ref, status: pr.status, wallet: await balances(item.customerId, item.countryCode) });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const cid = String(b.customer || 'demo');
      const country = String(b.country || 'UG');
      await seed(cid);
      const prof = registry.require(country);

      if (p === '/api/deposit') {
        const r = await rail.deposit(country, { customerId: cid, national: b.national || '700000001', amountLocal: String(b.amount) });
        if (r.status === 'completed') logAct(cid, `Cash in — ${b.amount} ${prof.localCurrency}`, 'pos');
        else if (r.status === 'pending') logAct(cid, `Cash in — ${b.amount} ${prof.localCurrency} · awaiting MoMo approval`, '');
        return send(res, 200, { result: r, wallet: await balances(cid, country) });
      }
      if (p === '/api/convert') {
        const r = await rail.convert(country, { customerId: cid, direction: b.direction, amount: String(b.amount) });
        logAct(cid, `Convert ${b.direction === 'local_to_usdt' ? `${b.amount} ${prof.localCurrency} → ${r.quote.net} USDT` : `${b.amount} USDT → ${r.quote.net} ${prof.localCurrency}`}`, 'pos');
        return send(res, 200, { quote: r.quote, wallet: await balances(cid, country) });
      }
      if (p === '/api/withdraw') {
        const r = await rail.withdraw(country, { customerId: cid, national: b.national || '700000001', amountLocal: String(b.amount) });
        if (r.status === 'completed') logAct(cid, `Cash out — ${b.amount} ${prof.localCurrency}`, 'neg');
        else if (r.status === 'pending') logAct(cid, `Cash out — ${b.amount} ${prof.localCurrency} · awaiting MoMo settlement`, '');
        return send(res, 200, { result: r, wallet: await balances(cid, country) });
      }
      if (p === '/api/payroll') {
        const payees = (b.payees || []).map((x: any) => ({ national: String(x.ph || '700000001'), amountLocal: String(x.amt) }));
        const r = await payroll.runBatch(country, { employerCustomerId: cid, payees });
        logAct(cid, `Payroll — paid ${r.paid}${r.failed ? `, ${r.failed} failed` : ''}`, r.failed ? 'neg' : 'pos');
        return send(res, 200, { result: r, wallet: await balances(cid, country) });
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (e: any) {
    send(res, 400, { error: e && e.message ? e.message : String(e) });
  }
});

async function start() {
  const store = makeStore();
  const boot = await bootstrap(store);
  ledger = boot.ledger;
  registry = boot.registry;
  rail = new RailService(ledger, registry, providers, fx);
  payroll = new PayrollService(ledger, registry, providers);
  for (const pr of registry.list()) {
    if (!rates[pr.localCurrency]) rates[pr.localCurrency] = await fx.getLocalPerUsdt(pr.localCurrency);
  }
  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, () => console.log(`momo-rail portal + API listening on :${PORT}`));
}

start().catch((e) => { console.error('momo-rail failed to start:', e); process.exit(1); });
