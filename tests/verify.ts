/**
 * Dependency-free verification runner (Node assert), mirroring the Jest suite so
 * the rail can be proven without a package install. Run: `npm run verify`.
 * The Jest suite in tests/*.test.ts is identical in intent and runs once the
 * dev-dependencies are installed in a normal environment.
 */
import assert from 'assert';
import { toMinor, fromMinor, scaleOf, roundTo } from '../src/ledger/money';
import { Ledger, UnbalancedEntryError, InsufficientBalanceError } from '../src/ledger/ledger';
import { seedProfiles } from '../src/config/countryProfile';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { createQuote } from '../src/exchange/exchange';
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { RailService, RailError } from '../src/rail/railService';
import { PayrollService } from '../src/payroll/payrollService';

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, `FAILED: ${name}`);
  passed++; console.log(`  ok  ${name}`);
}
async function throws(name: string, fn: () => Promise<unknown> | unknown, type?: Function) {
  try { await fn(); } catch (e) { if (type) assert.ok(e instanceof type, `${name}: wrong error type`); passed++; console.log(`  ok  ${name}`); return; }
  throw new Error(`FAILED: ${name} did not throw`);
}

async function main() {
  console.log('\nmoney');
  ok('scale per currency', scaleOf('USDT') === 6 && scaleOf('KES') === 2 && scaleOf('UGX') === 0);
  ok('KES round-trip', toMinor('100.00', 'KES') === 10000n && fromMinor(10000n, 'KES') === '100.00');
  ok('USDT round-trip', toMinor('5.500000', 'USDT') === 5500000n && fromMinor(5500000n, 'USDT') === '5.500000');
  ok('UGX truncates', toMinor('3800.99', 'UGX') === 3800n && fromMinor(3800n, 'UGX') === '3800');
  ok('negatives', toMinor('-12.34', 'KES') === -1234n && fromMinor(-1234n, 'KES') === '-12.34');
  ok('roundTo', roundTo(98.5, 'USDT') === '98.500000' && roundTo(3800.4, 'UGX') === '3800');

  console.log('ledger');
  {
    const l = new Ledger();
    const a = await l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = await l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    await l.postEntry({ entryType: 't', lines: [{ accountId: a.id, amount: '-500.00' }, { accountId: b.id, amount: '500.00' }] });
    ok('balanced entry moves value', (await l.getBalance(b.id)).balance === '500.00' && (await l.getBalance(a.id)).balance === '-500.00');
    await throws('unbalanced rejected', () => l.postEntry({ entryType: 'x', lines: [{ accountId: a.id, amount: '-1.00' }, { accountId: b.id, amount: '0.99' }] }), UnbalancedEntryError);
    const e1 = await l.postEntry({ entryType: 't', idempotencyKey: 'k', lines: [{ accountId: a.id, amount: '-100.00' }, { accountId: b.id, amount: '100.00' }] });
    const e2 = await l.postEntry({ entryType: 't', idempotencyKey: 'k', lines: [{ accountId: a.id, amount: '-100.00' }, { accountId: b.id, amount: '100.00' }] });
    ok('idempotent apply-once', e1.id === e2.id && (await l.getBalance(b.id)).balance === '600.00');
    const z = await l.createAccount({ customerId: 'z', currency: 'KES', accountType: 'customer_wallet' });
    await throws('insufficient guard', () => l.assertSufficientBalance(z.id, '1.00'), InsufficientBalanceError);
  }

  console.log('exchange');
  {
    const ps = seedProfiles();
    const UG = ps.find((p) => p.code === 'UG')!;
    const GH = ps.find((p) => p.code === 'GH')!;
    const fx = new FixedFxRateProvider();
    const q1 = await createQuote(UG, fx, 'local_to_usdt', '380000');
    ok('UGX->USDT rate+fee', q1.usdt === '100.000000' && q1.fee === '1.500000' && q1.net === '98.500000');
    const q2 = await createQuote(UG, fx, 'usdt_to_local', '100');
    ok('USDT->UGX fee in local', q2.local === '380000' && q2.fee === '5700' && q2.net === '374300');
    const q3 = await createQuote(GH, fx, 'local_to_usdt', '1550');
    ok('GHS->USDT same path', q3.net === '98.500000' && q3.feeCurrency === 'USDT');
  }

  console.log('rail (two-country, one code path)');
  for (const m of [
    { country: 'UG', national: '772123456', currency: 'UGX', deposit: '400000', convert: '380000', zero: '0' },
    { country: 'GH', national: '241234567', currency: 'GHS', deposit: '2000', convert: '1550', zero: '0.00' },
  ] as const) {
    const { ledger, registry } = await bootstrap();
    const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());
    const dep = await rail.deposit(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit });
    ok(`${m.country} deposit completes`, dep.status === 'completed');
    const cvt = await rail.convert(m.country, { customerId: 'c1', direction: 'local_to_usdt', amount: m.convert });
    ok(`${m.country} convert -> 98.5 USDT`, cvt.quote.net === '98.500000' && (await ledger.getBalance(cvt.usdtWalletId)).balance === '98.500000');
    const remaining = (await ledger.getBalance((await ledger.findCustomerWallet('c1', m.currency))!.id)).balance;
    const wd = await rail.withdraw(m.country, { customerId: 'c1', national: m.national, amountLocal: remaining });
    ok(`${m.country} withdraw completes and zeroes wallet`, wd.status === 'completed' && (await ledger.getBalance((await ledger.findCustomerWallet('c1', m.currency))!.id)).balance === m.zero);
  }

  console.log('guards');
  {
    const { ledger, registry } = await bootstrap();
    const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());
    const dep = await rail.deposit('GH', { customerId: 'c9', national: '241230000', amountLocal: '5000' });
    ok('declined prompt -> no balance', dep.status === 'failed' && (await ledger.getBalance((await ledger.findCustomerWallet('c9', 'GHS'))!.id)).balance === '0.00');
    await throws('sanctions hit blocks', () => rail.deposit('UG', { customerId: 'c1', national: '772123456', amountLocal: '100000', sanctionsHit: true }), RailError);
    await throws('unknown country rejected', () => rail.deposit('ZZ', { customerId: 'c1', national: '700000000', amountLocal: '1000' }));
  }

  console.log('payroll (MoMo Disbursements)');
  {
    const { ledger, registry } = await bootstrap();
    const providers = new ProviderRegistry();
    const rail = new RailService(ledger, registry, providers, new FixedFxRateProvider());
    const payroll = new PayrollService(ledger, registry, providers);
    await rail.deposit('UG', { customerId: 'emp', national: '772123456', amountLocal: '120000' });
    const res = await payroll.runBatch('UG', { employerCustomerId: 'emp', payees: [
      { national: '772111111', amountLocal: '100000', label: 'Mary' },
      { national: '772222222', amountLocal: '50000', label: 'John' }, // only 20000 left -> fails
    ]});
    ok('payroll pays until funds run out', res.paid === 1 && res.failed === 1);
    ok('employer debited only for the paid worker', (await ledger.getBalance((await ledger.findCustomerWallet('emp', 'UGX'))!.id)).balance === '20000');
  }

  console.log('multi-currency (every configured MoMo market, one code path)');
  {
    const { ledger, registry } = await bootstrap();
    const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());
    const markets = registry.list();
    const currencies = new Set<string>();
    let ran = 0;
    for (const p of markets) {
      const s0 = scaleOf(p.localCurrency) === 0;
      const dep = s0 ? '1000000' : '100000.00';
      const conv = s0 ? '500000' : '50000.00';
      await rail.deposit(p.code, { customerId: `c-${p.code}`, national: '700000001', amountLocal: dep });
      const cvt = await rail.convert(p.code, { customerId: `c-${p.code}`, direction: 'local_to_usdt', amount: conv });
      if (Number((await ledger.getBalance(cvt.usdtWalletId)).balance) > 0) { ran++; currencies.add(p.localCurrency); }
    }
    console.log(`      markets=${markets.length} currencies=${currencies.size} [${[...currencies].join(', ')}]`);
    ok(`ran all ${markets.length} MoMo markets on one code path`, ran === markets.length && markets.length >= 15);
    ok(`covering ${currencies.size} distinct currencies (incl. scale-0 UGX/XOF/XAF/RWF/GNF)`, currencies.size >= 10);
  }

  console.log(`\nALL PASSED — ${passed} assertions\n`);
}

main().catch((e) => { console.error('\n' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
