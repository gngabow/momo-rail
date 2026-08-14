import http from 'http';
import fs from 'fs';
import path from 'path';
import { bootstrap } from '../config/bootstrap';
import { Ledger } from '../ledger/ledger';
import { PgLedger } from '../ledger/pgLedger';
import { LedgerStore } from '../ledger/store';
import { fromMinor } from '../ledger/money';
import { CountryRegistry } from '../config/countryProfile';
import { ProviderRegistry } from '../providers/registry';
import { getMoMoConfigFromEnv } from '../providers/momoEnv';
import { FixedFxRateProvider } from '../fx/fxRateProvider';
import { RailService } from '../rail/railService';
import { PayrollService } from '../payroll/payrollService';
import { provisionWallet } from '../wallet/walletService';
import { PendingSettlements } from '../rail/settlement';
import { PgPendingSink } from '../rail/pgPending';
import { AuthService, AuthError, isIntlCustomer } from '../auth/authService';
import { OpsService, InMemoryOverrideStore, ProfileOverrideStore } from '../ops/opsService';
import { PgOverrideStore } from '../ops/pgOverrideStore';
import { ClaimStore } from '../remittance/claimStore';
import { PgClaimSink } from '../remittance/pgClaimSink';
import { RemittanceService } from '../remittance/remittanceService';
import { BillerService } from '../billers/billerService';
import { toMsisdn } from '../context/phone';
import crypto from 'crypto';

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
let auth: AuthService;
let ops: OpsService;
let remit: RemittanceService;
let billers: BillerService;
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

/** Provision a new customer's empty wallets so the portal has something to read.
 * Both the USDT and local wallets start at zero — a real customer funds them by
 * depositing local (then converting) or adding USDT, so nothing is granted for free. */
async function seed(cid: string) {
  if (seeded.has(cid)) return;
  seeded.add(cid);
  await provisionWallet(ledger, cid, 'USDT', null); // USDT wallet, 0 balance
  if (isIntlCustomer(cid)) return; // international customers hold USDT only (no local Opco wallet)
  const m = cid.match(/^cust:([A-Z]{2}):/);
  const known = registry.list().some((p) => p.code === (m ? m[1] : ''));
  const p = registry.require(known ? m![1] : 'UG'); // the customer's own market (default UG)
  await provisionWallet(ledger, cid, p.localCurrency, p.code); // local wallet, 0 balance
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

/** Admin: build a directory of customers from their wallet accounts, with balances.
 * Customer identity is `cust:<CC>:<msisdn>` (or `cust:INTL:<msisdn>` for USDT-only). */
async function customerDirectory(): Promise<any[]> {
  const accts = await ledger.listAccounts();
  const byCust = new Map<string, any>();
  for (const a of accts) {
    if (a.accountType !== 'customer_wallet' || !a.customerId) continue;
    let rec = byCust.get(a.customerId);
    if (!rec) {
      const m = /^cust:([A-Z]{2}):(.+)$/.exec(a.customerId);
      const intl = isIntlCustomer(a.customerId);
      rec = {
        cid: a.customerId,
        country: intl ? 'INTL' : (a.countryCode || (m ? m[1] : null)),
        msisdn: intl ? a.customerId.slice('cust:INTL:'.length) : (m ? m[2] : null),
        intl, wallets: [] as any[],
      };
      byCust.set(a.customerId, rec);
    }
    const bal = await ledger.getBalance(a.id);
    rec.wallets.push({ currency: a.currency, balance: bal.balance, countryCode: a.countryCode, status: a.status });
  }
  return [...byCust.values()];
}

function send(res: http.ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : undefined;
}
/** A resolved customer id: the signed-in customer's, else the caller-supplied demo id. */
function customerId(req: http.IncomingMessage, fallback: string): string {
  const s = auth.resolve(bearer(req));
  return s && s.kind === 'customer' ? s.subject : fallback;
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
        rate: rates[m.localCurrency], op: m.momoOperator, enabled: m.enabled,
        tested: m.licensing.regime.endsWith('pilot'),
      })));
    }
    if (p === '/api/wallet') {
      const cid = customerId(req, String(q.get('customer') || 'demo'));
      return send(res, 200, await balances(cid, String(q.get('country') || 'UG')));
    }
    if (p === '/api/activity') {
      const cid = customerId(req, String(q.get('customer') || 'demo'));
      return send(res, 200, activity.get(cid) || []);
    }
    if (p === '/api/pending') {
      const cid = customerId(req, String(q.get('customer') || 'demo'));
      return send(res, 200, rail.pendingStore().list().filter((x) => x.customerId === cid));
    }

    // ---- Auth: customer phone + OTP (local Opco or international USDT-only) ----
    if (p === '/api/auth/request-otp' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.intl) return send(res, 200, auth.requestOtpIntl(String(b.msisdn || '')));
      return send(res, 200, auth.requestOtp(String(b.country || 'UG'), String(b.national || '')));
    }
    if (p === '/api/auth/verify-otp' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.intl) {
        const v = auth.verifyOtpIntl(String(b.msisdn || ''), String(b.code || ''));
        return send(res, 200, { ...v, claimed: [] });
      }
      const country = String(b.country || 'UG');
      const v = auth.verifyOtp(country, String(b.national || ''), String(b.code || ''));
      // reserve-now, deliver-on-signup: hand over anything reserved for this number.
      const delivered = await remit.claimAllFor(country, v.msisdn, v.customerId);
      return send(res, 200, { ...v, claimed: delivered.map((d) => d.delivered) });
    }
    if (p === '/api/usdt-balance') {
      const cid = customerId(req, String(q.get('customer') || 'demo'));
      await seed(cid);
      const uw = await ledger.findCustomerWallet(cid, 'USDT');
      return send(res, 200, { usdt: uw ? (await ledger.getBalance(uw.id)).balance : '0.000000', intl: isIntlCustomer(cid) });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      auth.logout(bearer(req));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/auth/me') {
      const s = auth.resolve(bearer(req));
      return send(res, 200, s ? { authenticated: true, kind: s.kind, subject: s.subject } : { authenticated: false });
    }

    // ---- Admin sign-in (unauthenticated) ----
    if (p === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, auth.adminLogin(String(b.username || ''), String(b.password || '')));
    }
    // ---- Admin + ops console (admin session required) ----
    if (p.startsWith('/api/admin/')) {
      const s = auth.resolve(bearer(req));
      if (!s || s.kind !== 'admin') return send(res, 401, { error: 'admin auth required' });
      if (p === '/api/admin/markets') {
        return send(res, 200, registry.list().map((m) => ({
          code: m.code, name: m.displayName, enabled: m.enabled, ccy: m.localCurrency,
          providerKey: m.providerKey, providerEnv: m.providerEnv, merchantModel: m.merchantModel,
          feeSchedule: m.feeSchedule, limits: m.limits, features: m.features, operator: m.momoOperator,
        })));
      }
      const mk = /^\/api\/admin\/market\/([A-Za-z]{2})$/.exec(p);
      if (mk && req.method === 'POST') {
        const b = await readBody(req);
        const u = await ops.updateMarket(mk[1], {
          enabled: b.enabled, providerKey: b.providerKey, providerEnv: b.providerEnv, merchantModel: b.merchantModel,
          feeSchedule: b.feeSchedule, limits: b.limits, features: b.features,
        });
        return send(res, 200, { updated: { code: u.code, enabled: u.enabled, providerKey: u.providerKey, providerEnv: u.providerEnv, merchantModel: u.merchantModel, feeSchedule: u.feeSchedule, limits: u.limits, features: u.features } });
      }

      // Overview strip — storage mode and market counts at a glance.
      if (p === '/api/admin/overview') {
        const list = registry.list();
        return send(res, 200, {
          store: process.env.DATABASE_URL ? 'postgres' : 'memory',
          markets: list.length,
          enabled: list.filter((m) => m.enabled).length,
          liveOnMtn: list.filter((m) => m.providerKey === 'momo').length,
          currencies: new Set(list.map((m) => m.localCurrency)).size,
          walletsSeeded: seeded.size,
        });
      }

      // Treasury — system money position: per-currency float/fees/suspense/biller + shared USDT.
      if (p === '/api/admin/treasury') {
        const g = async (id: string) => (await ledger.getBalance(id)).balance;
        const seen = new Set<string>();
        const local: any[] = [];
        for (const prof of registry.list()) {
          const ccy = prof.localCurrency;
          if (seen.has(ccy)) continue;
          seen.add(ccy);
          local.push({
            currency: ccy,
            float: await g(`sys-${ccy}-float`),
            feeRevenue: await g(`sys-${ccy}-feerev`),
            suspense: await g(`sys-${ccy}-suspense`),
            biller: await g(`sys-${ccy}-biller`),
          });
        }
        const usdt = {
          hotWallet: await g('sys-USDT-hot'),
          feeRevenue: await g('sys-USDT-feerev'),
          remitEscrow: await g('sys-USDT-remit-escrow'),
        };
        return send(res, 200, { usdt, local });
      }

      // In-flight — pending MoMo settlements + reserved remittance claims.
      if (p === '/api/admin/inflight') {
        return send(res, 200, { pending: rail.pendingStore().list(), claims: remit.reservedClaims() });
      }

      // System-wide activity feed (most recent journal entries).
      if (p === '/api/admin/activity') {
        const entries = await ledger.listEntries();
        const recent = entries.slice(-30).reverse().map((e) => {
          const pos = e.lines.filter((l) => Number(l.amount) > 0).sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))[0];
          return { type: e.entryType, amount: pos ? pos.amount : '', currency: pos ? pos.currency : '', at: e.createdAt };
        });
        return send(res, 200, recent);
      }

      // Customer 360 — directory of customers with their wallet balances.
      if (p === '/api/admin/customers') {
        const dir = await customerDirectory();
        const rows = dir.map((c) => ({
          cid: c.cid, country: c.country, msisdn: c.msisdn, intl: c.intl,
          wallets: c.wallets.length,
          usdt: (c.wallets.find((w: any) => w.currency === 'USDT') || {}).balance || '0.000000',
          local: (c.wallets.find((w: any) => w.currency !== 'USDT') || {}),
          activity: (activity.get(c.cid) || []).length,
        }));
        return send(res, 200, { count: rows.length, customers: rows });
      }
      // Customer 360 — one customer's full picture.
      if (p === '/api/admin/customer') {
        const cid = String(q.get('cid') || '');
        const dir = await customerDirectory();
        const c = dir.find((x) => x.cid === cid);
        if (!c) return send(res, 404, { error: 'unknown customer' });
        return send(res, 200, {
          cid: c.cid, country: c.country, msisdn: c.msisdn, intl: c.intl,
          wallets: c.wallets, activity: activity.get(cid) || [], outbox: remit.outboxFor(cid),
        });
      }

      // Compliance — per-market KYC/sanctions/licensing config + large-value monitoring queue.
      if (p === '/api/admin/compliance') {
        const markets = registry.list().map((m) => ({
          code: m.code, name: m.displayName, ccy: m.localCurrency, enabled: m.enabled,
          kyc: m.kycProviderKey, sanctions: m.sanctionsProviderKey,
          reviewThresholdLocal: m.screening.reviewThresholdLocal, blockOnSanctionsHit: m.screening.blockOnSanctionsHit,
          vaspLicensed: m.licensing.vaspLicensed, regime: m.licensing.regime, perTxMaxLocal: m.limits.perTxMaxLocal,
        }));
        const REVIEW_USDT = 1000; // demo AML large-value flag (USDT-equivalent)
        const entries = await ledger.listEntries();
        const monitor = entries.slice(-60).reverse().map((e) => {
          const line = e.lines.filter((l) => Number(l.amount) > 0).sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))[0];
          if (!line) return null;
          const ccy = line.currency;
          const rate = ccy === 'USDT' ? 1 : Number(rates[ccy] || 0);
          const usdtEq = ccy === 'USDT' ? Number(line.amount) : (rate ? Number(line.amount) / rate : 0);
          return { type: e.entryType, amount: line.amount, currency: ccy, usdtEquiv: usdtEq.toFixed(2), review: usdtEq >= REVIEW_USDT, at: e.createdAt };
        }).filter(Boolean) as any[];
        return send(res, 200, { reviewThresholdUsdt: REVIEW_USDT, flagged: monitor.filter((m) => m.review).length, markets, monitor });
      }

      // Reconciliation — double-entry integrity: system + customer balances net to zero per currency.
      if (p === '/api/admin/reconciliation') {
        const accts = await ledger.listAccounts();
        const byCcy = new Map<string, { currency: string; systemMinor: bigint; customerMinor: bigint; accounts: number }>();
        for (const a of accts) {
          const b = await ledger.getBalance(a.id);
          const rec = byCcy.get(a.currency) || { currency: a.currency, systemMinor: 0n, customerMinor: 0n, accounts: 0 };
          if (a.accountType === 'customer_wallet') rec.customerMinor += b.minor; else rec.systemMinor += b.minor;
          rec.accounts++;
          byCcy.set(a.currency, rec);
        }
        const rows = [...byCcy.values()].map((r) => {
          const residual = r.systemMinor + r.customerMinor;
          return {
            currency: r.currency, accounts: r.accounts,
            system: fromMinor(r.systemMinor, r.currency),
            customer: fromMinor(r.customerMinor, r.currency),
            residual: fromMinor(residual, r.currency),
            balanced: residual === 0n,
          };
        });
        return send(res, 200, {
          balanced: rows.every((r) => r.balanced),
          currencies: rows.length,
          rows,
          inFlight: { pendingSettlements: rail.pendingStore().list().length, reservedClaims: remit.reservedClaims().length },
        });
      }

      // Support — agent lookup: find customers by number/country and show a snapshot.
      if (p === '/api/admin/support') {
        const term = String(q.get('q') || '').trim().toLowerCase();
        const dir = await customerDirectory();
        const match = dir.filter((c) => !term
          || String(c.msisdn || '').toLowerCase().includes(term)
          || String(c.country || '').toLowerCase().includes(term)
          || String(c.cid).toLowerCase().includes(term));
        const rows = match.slice(0, 25).map((c) => {
          const acts = activity.get(c.cid) || [];
          return {
            cid: c.cid, country: c.country, msisdn: c.msisdn, intl: c.intl,
            wallets: c.wallets, activityCount: acts.length, lastActivity: acts[0] ? acts[0].text : null,
          };
        });
        return send(res, 200, { count: match.length, results: rows });
      }

      // Biller admin — full directory (incl. disabled) for editing.
      if (p === '/api/admin/billers') {
        return send(res, 200, billers.listAll(q.get('country') ? String(q.get('country')) : undefined));
      }
      // Biller admin — create/update or enable/disable a biller.
      if (p === '/api/admin/biller' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.action === 'toggle') return send(res, 200, { biller: billers.setEnabled(String(b.code || ''), !!b.enabled) });
        const biller = billers.upsert({ code: String(b.code || ''), name: String(b.name || ''), country: String(b.country || ''), category: b.category ? String(b.category) : undefined, enabled: b.enabled });
        return send(res, 200, { biller });
      }

      return send(res, 404, { error: 'unknown admin route' });
    }

    // ---- Remittance (invite / claim) — reads ----
    if (p === '/api/remit/outbox') {
      const cid = customerId(req, String(q.get('customer') || 'demo'));
      return send(res, 200, remit.outboxFor(cid));
    }
    if (p === '/api/remit/inbox') {
      const country = String(q.get('country') || 'UG');
      const profile = registry.require(country);
      const msisdn = toMsisdn(profile, String(q.get('national') || ''));
      return send(res, 200, remit.inboxFor(country, msisdn));
    }
    if (p === '/api/billers') {
      return send(res, 200, billers.list(q.get('country') ? String(q.get('country')) : undefined));
    }

    // MoMo provider callback — MTN posts the terminal state here (X-Callback-Url).
    // Settles the matching in-flight deposit/withdraw exactly once.
    if (p.startsWith('/api/momo/callback/') && req.method === 'POST') {
      const secret = process.env.MOMO_CALLBACK_SECRET;
      if (secret) {
        const provided = String(req.headers['x-callback-secret'] || '');
        const a = Buffer.from(provided), bb = Buffer.from(secret);
        if (a.length !== bb.length || !crypto.timingSafeEqual(a, bb)) return send(res, 401, { error: 'bad callback signature' });
      }
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
      const cid = customerId(req, String(b.customer || 'demo'));
      const country = String(b.country || 'UG');
      await seed(cid);
      const prof = registry.require(country);

      if (p === '/api/usdt/topup') {
        const uw = await provisionWallet(ledger, cid, 'USDT', null);
        const amt = String(b.amount);
        await ledger.postEntry({ entryType: 'usdt_topup', lines: [{ accountId: 'sys-USDT-hot', amount: `-${amt}` }, { accountId: uw.id, amount: amt }] });
        logAct(cid, `Added ${amt} USDT`, 'pos');
        return send(res, 200, { usdt: (await ledger.getBalance(uw.id)).balance });
      }
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
      if (p === '/api/remit/send') {
        const r = await remit.send({ senderCustomerId: cid, destCountry: String(b.destCountry || 'UG'), destNational: String(b.destNational || ''), amountUsdt: String(b.amountUsdt) });
        logAct(cid, `Sent ${b.amountUsdt} USDT → +${r.claim.destMsisdn} · reserved (code ${r.claim.code})`, 'neg');
        return send(res, 200, { claim: r.claim, estimate: r.estimate, wallet: await balances(cid, country) });
      }
      if (p === '/api/remit/claim') {
        const r = await remit.claim(String(b.idOrCode || b.claimId || b.code || ''), cid);
        logAct(cid, `Claimed remittance — received ${r.delivered.amount} ${r.delivered.currency}`, 'pos');
        return send(res, 200, { claim: r.claim, delivered: r.delivered, wallet: await balances(cid, r.claim.destCountry) });
      }
      if (p === '/api/bill/pay') {
        const rc = await billers.pay({ customerId: cid, billerCode: String(b.billerCode || ''), amount: String(b.amount) });
        logAct(cid, `Paid ${rc.amount} ${rc.currency} — ${rc.billerName}`, 'neg');
        return send(res, 200, { receipt: rc, wallet: await balances(cid, country) });
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (e: any) {
    const code = e instanceof AuthError ? 401 : 400;
    send(res, code, { error: e && e.message ? e.message : String(e) });
  }
});

async function start() {
  const url = process.env.DATABASE_URL;
  const store = makeStore();
  const boot = await bootstrap(store);
  ledger = boot.ledger;
  registry = boot.registry;

  // Durable pending settlements (write-through) when a DB is configured.
  let pending: PendingSettlements;
  if (url) {
    const sink = new PgPendingSink(url);
    await sink.init();
    pending = new PendingSettlements(sink);
    const n = await pending.hydrate();
    if (n) console.log(`momo-rail: hydrated ${n} in-flight settlement(s) from Postgres`);
  } else {
    pending = new PendingSettlements();
  }

  rail = new RailService(ledger, registry, providers, fx, pending);
  payroll = new PayrollService(ledger, registry, providers);

  // Ops-console overrides (durable market edits) + auth.
  const overrideStore: ProfileOverrideStore = url ? new PgOverrideStore(url) : new InMemoryOverrideStore();
  if (overrideStore.init) await overrideStore.init();
  ops = new OpsService(registry, overrideStore);
  const applied = await ops.loadOverrides();
  if (applied) console.log(`momo-rail: applied ${applied} ops override(s)`);
  auth = new AuthService(registry);

  // Remittance (invite/claim) with durable reservations, and bill pay / MoMoPay.
  let claims: ClaimStore;
  if (url) {
    const sink = new PgClaimSink(url);
    await sink.init();
    claims = new ClaimStore(sink);
    const n = await claims.hydrate();
    if (n) console.log(`momo-rail: hydrated ${n} reserved remittance claim(s)`);
  } else {
    claims = new ClaimStore();
  }
  remit = new RemittanceService(ledger, registry, fx, claims);
  billers = new BillerService(ledger, registry);

  for (const pr of registry.list()) {
    if (!rates[pr.localCurrency]) rates[pr.localCurrency] = await fx.getLocalPerUsdt(pr.localCurrency);
  }
  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, () => console.log(`momo-rail portal + API listening on :${PORT}`));
}

start().catch((e) => { console.error('momo-rail failed to start:', e); process.exit(1); });
