/**
 * Remittance invite/claim + bill pay proof (in-memory).
 * Run: `ts-node -T tests/verify-remit.ts`.
 */
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { ClaimStore } from '../src/remittance/claimStore';
import { RemittanceService } from '../src/remittance/remittanceService';
import { BillerService } from '../src/billers/billerService';
import { customerIdFor } from '../src/auth/authService';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

async function main() {
  const { ledger, registry } = await bootstrap();
  const fx = new FixedFxRateProvider();
  const rail = new RailService(ledger, registry, new ProviderRegistry(), fx);
  const remit = new RemittanceService(ledger, registry, fx, new ClaimStore());
  const billers = new BillerService(ledger, registry);

  const alice = 'cust:UG:sender-alice';
  const bal = async (cid: string, ccy: string) => {
    const w = await ledger.findCustomerWallet(cid, ccy);
    return w ? (await ledger.getBalance(w.id)).balance : null;
  };
  const sys = async (id: string) => (await ledger.getBalance(id)).balance;

  console.log('\nremittance (invite / claim, cross-border)');
  // Fund Alice with USDT: deposit UGX then convert.
  await rail.deposit('UG', { customerId: alice, national: '772123456', amountLocal: '400000' });
  await rail.convert('UG', { customerId: alice, direction: 'local_to_usdt', amount: '380000' });
  ok('sender funded with 98.5 USDT', (await bal(alice, 'USDT')) === '98.500000');

  // Alice sends 50 USDT to a Kenyan phone that isn't registered yet.
  const sent = await remit.send({ senderCustomerId: alice, destCountry: 'KE', destNational: '712345678', amountUsdt: '50' });
  ok('reservation created', sent.claim.status === 'reserved' && !!sent.claim.code);
  ok('funds moved to escrow', (await sys('sys-USDT-remit-escrow')) === '50.000000');
  ok('sender debited (48.5 USDT left)', (await bal(alice, 'USDT')) === '48.500000');
  ok('estimate: 50 USDT -> 6321 KES net (2% fee)', sent.estimate.net === '6321.00' && sent.estimate.fee === '129.00');

  // Recipient (Bob = the KE phone) claims — funds delivered in KES.
  const bob = customerIdFor('KE', '254712345678');
  ok('recipient has no wallet yet', (await bal(bob, 'KES')) === null);
  const claimed = await remit.claim(sent.claim.id, bob);
  ok('claim delivers 6321 KES', claimed.delivered.amount === '6321.00' && claimed.delivered.currency === 'KES');
  ok('recipient KES wallet credited', (await bal(bob, 'KES')) === '6321.00');
  ok('escrow drained after claim', (await sys('sys-USDT-remit-escrow')) === '0.000000');
  ok('double-claim rejected', await rejects(() => remit.claim(sent.claim.id, bob)));

  console.log('bill pay / MoMoPay');
  const list = billers.list('KE');
  ok('KE biller directory seeded', list.length >= 4 && list.some((b) => b.code === 'KE-ELEC'));
  const receipt = await billers.pay({ customerId: bob, billerCode: 'KE-ELEC', amount: '1000' });
  ok('bill paid (MoMoPay-labelled? paybill_till for KE)', receipt.model === 'paybill_till' && receipt.amount === '1000');
  ok('payer debited to 5321 KES', (await bal(bob, 'KES')) === '5321.00');
  ok('biller pool credited 1000 KES', (await sys('sys-KES-biller')) === '1000.00');

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

main().catch((e) => { console.error(e); process.exit(1); });
