import http from 'http';
import fs from 'fs';
import path from 'path';
import { bootstrap } from '../config/bootstrap';
import { ProviderRegistry } from '../providers/registry';
import { FixedFxRateProvider } from '../fx/fxRateProvider';
import { RailService } from '../rail/railService';
import { PayrollService } from '../payroll/payrollService';
import { provisionWallet } from '../wallet/walletService';

/**
 * Zero-dependency HTTP server (Node's built-in `http`) that puts the tested
 * momo-rail engine behind a small JSON API and serves the wallet portal.
 * In-memory state (resets on restart) with the mock MoMo adapter — a live,
 * clickable demo of the real rail, no external services required.
 */
const { ledger, registry } = bootstrap();
const providers = new ProviderRegistry();
const fx = new FixedFxRateProvider();
const rail = new RailService(ledger, registry, providers, fx);
const payroll = new PayrollService(ledger, registry, providers);

// Precompute display rates per currency for the markets list.
const rates: Record<string, string> = {};
(async () => { for (const p of registry.list()) { if (!rates[p.localCurrency]) rates[p.localCurrency] = await fx.getLocalPerUsdt(p.localCurrency); } })();

const seeded = new Set<string>();
const activity = new Map<string, { t: number; text: string; cls: string }[]>();
function logAct(cid: string, text: string, cls = '') {
  const a = activity.get(cid) || [];
  a.unshift({ t: Date.now(), text, cls });
  activity.set(cid, a.slice(0, 20));
}

/** Give a new demo customer a starting balance so the portal is usable at once. */
function seed(cid: string) {
  if (seeded.has(cid)) return;
  seeded.add(cid);
  const uw = provisionWallet(ledger, cid, 'USDT', null);
  ledger.postEntry({ entryType: 'demo_seed', lines: [{ accountId: 'sys-USDT-hot', amount: '-250' }, { accountId: uw.id, amount: '250' }] });
  const starters: [string, string, string][] = [['UG', 'UGX', '400000'], ['KE', 'KES', '15000']];
  for (const [code, ccy, amt] of starters) {
    const p = registry.get(code);
    const w = provisionWallet(ledger, cid, ccy, code);
    ledger.postEntry({ entryType: 'demo_seed', lines: [{ accountId: p.ledgerAccounts.localFloatId, amount: `-${amt}` }, { accountId: w.id, amount: amt }] });
  }
}

function balances(cid: string, code: string) {
  seed(cid);
  const p = registry.require(code);
  const lw = ledger.findCustomerWallet(cid, p.localCurrency);
  const uw = ledger.findCustomerWallet(cid, 'USDT');
  return {
    country: p.code, name: p.displayName, localCurrency: p.localCurrency, dial: p.dialCode,
    operator: p.momoOperator, rate: rates[p.localCurrency],
    local: lw ? ledger.getBalance(lw.id).balance : '0',
    usdt: uw ? ledger.getBalance(uw.id).balance : '0.000000',
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
    if (p === '/health') return send(res, 200, { ok: true, markets: registry.list().length });

    if (p === '/api/markets') {
      return send(res, 200, registry.list().map((m) => ({
        code: m.code, name: m.displayName, ccy: m.localCurrency, dial: m.dialCode,
        rate: rates[m.localCurrency], op: m.momoOperator,
        tested: m.licensing.regime.endsWith('pilot'),
      })));
    }
    if (p === '/api/wallet') {
      const cid = String(q.get('customer') || 'demo');
      return send(res, 200, balances(cid, String(q.get('country') || 'UG')));
    }
    if (p === '/api/activity') {
      const cid = String(q.get('customer') || 'demo');
      return send(res, 200, activity.get(cid) || []);
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const cid = String(b.customer || 'demo');
      const country = String(b.country || 'UG');
      seed(cid);
      const prof = registry.require(country);

      if (p === '/api/deposit') {
        const r = await rail.deposit(country, { customerId: cid, national: b.national || '700000001', amountLocal: String(b.amount) });
        if (r.status === 'completed') logAct(cid, `Cash in — ${b.amount} ${prof.localCurrency}`, 'pos');
        return send(res, 200, { result: r, wallet: balances(cid, country) });
      }
      if (p === '/api/convert') {
        const r = await rail.convert(country, { customerId: cid, direction: b.direction, amount: String(b.amount) });
        logAct(cid, `Convert ${b.direction === 'local_to_usdt' ? `${b.amount} ${prof.localCurrency} → ${r.quote.net} USDT` : `${b.amount} USDT → ${r.quote.net} ${prof.localCurrency}`}`, 'pos');
        return send(res, 200, { quote: r.quote, wallet: balances(cid, country) });
      }
      if (p === '/api/withdraw') {
        const r = await rail.withdraw(country, { customerId: cid, national: b.national || '700000001', amountLocal: String(b.amount) });
        if (r.status === 'completed') logAct(cid, `Cash out — ${b.amount} ${prof.localCurrency}`, 'neg');
        return send(res, 200, { result: r, wallet: balances(cid, country) });
      }
      if (p === '/api/payroll') {
        const payees = (b.payees || []).map((x: any) => ({ national: String(x.ph || '700000001'), amountLocal: String(x.amt) }));
        const r = await payroll.runBatch(country, { employerCustomerId: cid, payees });
        logAct(cid, `Payroll — paid ${r.paid}${r.failed ? `, ${r.failed} failed` : ''}`, r.failed ? 'neg' : 'pos');
        return send(res, 200, { result: r, wallet: balances(cid, country) });
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (e: any) {
    send(res, 400, { error: e && e.message ? e.message : String(e) });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`momo-rail portal + API listening on :${PORT}`));
