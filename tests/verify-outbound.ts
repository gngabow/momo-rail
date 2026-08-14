/**
 * Outbound remittance: Opco → international (non-Opco) delivered in USDT, C2C & C2B.
 * Run: `ts-node -T tests/verify-outbound.ts`.
 * The sender's USDT is reserved into escrow and delivered as USDT (no local
 * conversion) to the recipient's international USDT account, less an outbound fee.
 */
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { ClaimStore } from '../src/remittance/claimStore';
import { RemittanceService } from '../src/remittance/remittanceService';
import { customerIdFor } from '../src/auth/authService';

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
  const fx = new FixedFxRateProvider();
  const rail = new RailService(ledger, registry, new ProviderRegistry(), fx);
  const remit = new RemittanceService(ledger, registry, fx, new ClaimStore());

  const alice = 'cust:UG:256772123456';
  const bal = async (cid: string, ccy: string) => {
    const w = await ledger.findCustomerWallet(cid, ccy);
    return w ? (await ledger.getBalance(w.id)).balance : null;
  };
  const sys = async (id: string) => (await ledger.getBalance(id)).balance;

  console.log('\noutbound: fund an Opco sender with USDT');
  await rail.deposit('UG', { customerId: alice, national: '772123456', amountLocal: '400000' });
  await rail.convert('UG', { customerId: alice, direction: 'local_to_usdt', amount: '380000' });
  ok('sender holds 98.5 USDT', (await bal(alice, 'USDT')) === '98.500000');

  console.log('C2C: Opco → UK number, delivered in USDT (2% outbound fee)');
  const sent = await remit.sendIntl({ senderCustomerId: alice, destMsisdn: '+44 7700 900123', amountUsdt: '50' });
  ok('reserved to INTL destination', sent.claim.status === 'reserved' && sent.claim.destCountry === 'INTL');
  ok('recipient type defaults to person', sent.claim.recipientType === 'person');
  ok('estimate delivers USDT, 49 net / 1 fee', sent.estimate.currency === 'USDT' && sent.estimate.net === '49.000000' && sent.estimate.fee === '1.000000');
  ok('funds moved to escrow', (await sys('sys-USDT-remit-escrow')) === '50.000000');
  ok('sender debited (48.5 left)', (await bal(alice, 'USDT')) === '48.500000');

  const uk = customerIdFor('INTL', '447700900123');
  ok('recipient has no USDT wallet yet', (await bal(uk, 'USDT')) === null);
  const claimed = await remit.claim(sent.claim.id, uk);
  ok('delivers 49 USDT (not local currency)', claimed.delivered.amount === '49.000000' && claimed.delivered.currency === 'USDT');
  ok('recipient USDT wallet credited', (await bal(uk, 'USDT')) === '49.000000');
  ok('escrow drained after claim', (await sys('sys-USDT-remit-escrow')) === '0.000000');

  console.log('C2B: Opco → a business USDT wallet');
  const biz = await remit.sendIntl({ senderCustomerId: alice, destMsisdn: '13105550111', amountUsdt: '10', recipientType: 'business', destLabel: 'Acme Corp' });
  ok('reserved as business (C2B)', biz.claim.recipientType === 'business' && biz.claim.destLabel === 'Acme Corp');
  const acme = customerIdFor('INTL', '13105550111');
  const bizDone = await remit.claim(biz.claim.id, acme);
  ok('business receives 9.8 USDT (10 - 2%)', bizDone.delivered.amount === '9.800000' && (await bal(acme, 'USDT')) === '9.800000');

  console.log('auto-deliver on international sign-in');
  const sent3 = await remit.sendIntl({ senderCustomerId: alice, destMsisdn: '447700900999', amountUsdt: '5' });
  ok('third reservation held in escrow', (await sys('sys-USDT-remit-escrow')) === '5.000000' && sent3.claim.status === 'reserved');
  const carol = customerIdFor('INTL', '447700900999');
  const auto = await remit.claimAllFor('INTL', '447700900999', carol);
  ok('sign-in auto-claims the reservation', auto.length === 1 && auto[0].delivered.amount === '4.900000');
  ok('escrow fully drained', (await sys('sys-USDT-remit-escrow')) === '0.000000');

  console.log('outbound feature flag is enforced on the sender market');
  const ug = registry.get('UG');
  ug.features.outboundRemittance = false;
  ok('disabled market blocks outbound', await rejects(() => remit.sendIntl({ senderCustomerId: alice, destMsisdn: '447700900123', amountUsdt: '1' })));
  ug.features.outboundRemittance = true;
  ok('re-enabled market allows outbound again', !(await rejects(() => remit.sendIntl({ senderCustomerId: alice, destMsisdn: '447700900123', amountUsdt: '1' }))));

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
