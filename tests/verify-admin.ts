/**
 * Admin-parity sections: ledger enumeration, reconciliation integrity, and the
 * biller admin (enable/disable/upsert). Run: `ts-node -T tests/verify-admin.ts`.
 * These back the Customer 360, Reconciliation and Billers admin tabs.
 */
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { BillerService, BillerError } from '../src/billers/billerService';
import { fromMinor } from '../src/ledger/money';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  const { ledger, registry } = await bootstrap();
  const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());
  const billers = new BillerService(ledger, registry);

  console.log('\nledger enumeration (Customer 360)');
  const alice = 'cust:UG:256772000001';
  const bob = 'cust:GH:233241234567';
  await rail.deposit('UG', { customerId: alice, national: '772000001', amountLocal: '400000' });
  await rail.convert('UG', { customerId: alice, direction: 'local_to_usdt', amount: '380000' });
  await rail.deposit('GH', { customerId: bob, national: '241234567', amountLocal: '1550' });

  const accts = await ledger.listAccounts();
  ok('listAccounts returns accounts', accts.length > 0);
  const custWallets = accts.filter((a) => a.accountType === 'customer_wallet' && a.customerId);
  const customers = new Set(custWallets.map((a) => a.customerId));
  ok('two distinct customers discovered', customers.has(alice) && customers.has(bob) && customers.size === 2);
  ok('alice has UGX + USDT wallets', custWallets.filter((a) => a.customerId === alice).length === 2);

  console.log('reconciliation (double-entry integrity)');
  // Every currency must net to exactly zero across system + customer accounts.
  const byCcy = new Map<string, bigint>();
  for (const a of accts) {
    const b = await ledger.getBalance(a.id);
    byCcy.set(a.currency, (byCcy.get(a.currency) ?? 0n) + b.minor);
  }
  let allZero = true;
  for (const [ccy, sum] of byCcy) { if (sum !== 0n) { allZero = false; console.log(`      residual ${ccy}=${fromMinor(sum, ccy)}`); } }
  ok('books balance — every currency nets to zero', allZero);
  ok('UGX and USDT both present in the books', byCcy.has('UGX') && byCcy.has('USDT'));

  console.log('biller admin (enable / disable / upsert)');
  ok('customer list excludes disabled; listAll includes them', billers.list('UG').length === billers.listAll('UG').length);
  billers.setEnabled('UG-ELEC', false);
  ok('disabling drops it from the customer list', !billers.list('UG').some((b) => b.code === 'UG-ELEC'));
  ok('but it remains in the admin list', billers.listAll('UG').some((b) => b.code === 'UG-ELEC'));
  ok('paying a disabled biller is rejected', await rejects(() => billers.pay({ customerId: bob, billerCode: 'UG-ELEC', amount: '100' })));
  const added = billers.upsert({ code: 'UG-DSTV', name: 'DSTV · Uganda', country: 'UG', category: 'TV' });
  ok('upsert creates a new enabled biller with market currency', added.currency === 'UGX' && added.enabled === true);
  ok('new biller is visible to customers', billers.list('UG').some((b) => b.code === 'UG-DSTV'));
  ok('upsert onto an unknown market is rejected', await rejects(async () => billers.upsert({ code: 'ZZ-X', name: 'x', country: 'ZZ' })));

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
