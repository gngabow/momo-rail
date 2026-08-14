/**
 * Async settlement proof — the real-MoMo path where collect/disburse return
 * `pending` (202) and the ledger only moves when a callback/poll confirms.
 * Dependency-free; run with `ts-node -T tests/verify-async.ts`.
 */
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { MobileMoneyProvider, ProviderResult, NormalizedCallback } from '../src/providers/mobileMoneyProvider';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/** Always returns pending — stands in for a real MoMo 202 accepted. */
class PendingProvider implements MobileMoneyProvider {
  readonly key = 'pending-test';
  async collect(): Promise<ProviderResult> { return { providerRef: 'p-collect', status: 'pending' }; }
  async disburse(): Promise<ProviderResult> { return { providerRef: 'p-disburse', status: 'pending' }; }
  async status(): Promise<ProviderResult> { return { providerRef: 'p', status: 'pending' }; }
  handleCallback(): NormalizedCallback { return { reference: '', providerRef: '', status: 'pending' }; }
}
class PendingRegistry extends ProviderRegistry {
  resolve(): MobileMoneyProvider { return new PendingProvider(); }
}

async function main() {
  const { ledger, registry } = await bootstrap();
  const rail = new RailService(ledger, registry, new PendingRegistry(), new FixedFxRateProvider());
  const cust = 'cust-async';
  const bal = async () => {
    const w = await ledger.findCustomerWallet(cust, 'UGX');
    return w ? (await ledger.getBalance(w.id)).minor : 0n;
  };
  const susBal = async () => (await ledger.getBalance('sys-UGX-suspense')).minor;

  console.log('async settlement (real-MoMo pending path)');

  // Deposit -> pending: nothing credited yet.
  const dep = await rail.deposit('UG', { customerId: cust, national: '700000001', amountLocal: '1000' });
  ok('deposit returns pending', dep.status === 'pending');
  ok('deposit not credited before confirmation', (await bal()) === 0n);
  ok('pending item recorded', rail.pendingStore().get(dep.reference)?.status === 'pending');

  // Callback confirms SUCCESSFUL -> credited exactly once.
  await rail.settle(dep.reference, 'success', 'fin-123');
  ok('deposit credited after settle', (await bal()) === 1000n);
  await rail.settle(dep.reference, 'success'); // duplicate callback
  ok('settle is idempotent (duplicate callback)', (await bal()) === 1000n);

  // Withdraw -> pending: funds held (wallet debited into suspense) but not yet gone.
  const wd = await rail.withdraw('UG', { customerId: cust, national: '700000001', amountLocal: '400' });
  ok('withdraw returns pending', wd.status === 'pending');
  ok('withdraw holds funds (wallet debited to 600)', (await bal()) === 600n);
  ok('held funds parked in suspense', (await susBal()) === 400n);

  // Callback says FAILED -> hold reversed, wallet made whole, suspense back to 0.
  await rail.settle(wd.reference, 'failed', undefined, 'payee unreachable');
  ok('failed withdraw reverses hold (wallet back to 1000)', (await bal()) === 1000n);
  ok('suspense drained after reversal', (await susBal()) === 0n);

  // A second withdraw that succeeds drains from suspense to float.
  const wd2 = await rail.withdraw('UG', { customerId: cust, national: '700000001', amountLocal: '250' });
  await rail.settle(wd2.reference, 'success', 'fin-456');
  ok('successful withdraw settles (wallet 750)', (await bal()) === 750n);
  ok('suspense drained after success', (await susBal()) === 0n);

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
