/**
 * Request-a-payment + member-to-member P2P settlement.
 * Run: `ts-node -T tests/verify-requests.ts`.
 * A customer raises a request (USDT or local currency); another customer pays it,
 * moving funds member-to-member as one balanced same-currency ledger entry.
 */
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { RequestService } from '../src/requests/requestService';
import { provisionWallet } from '../src/wallet/walletService';

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
  const reqs = new RequestService(ledger, registry);

  const alice = 'cust:UG:256772000001';
  const bob = 'cust:UG:256772000002';
  const bal = async (cid: string, ccy: string) => {
    const w = await ledger.findCustomerWallet(cid, ccy);
    return w ? (await ledger.getBalance(w.id)).balance : null;
  };

  console.log('\nfund two members');
  await rail.deposit('UG', { customerId: alice, national: '772000001', amountLocal: '400000' });
  await rail.convert('UG', { customerId: alice, direction: 'local_to_usdt', amount: '380000' }); // alice: 20000 UGX, 98.5 USDT
  await rail.deposit('UG', { customerId: bob, national: '772000002', amountLocal: '400000' });
  await rail.convert('UG', { customerId: bob, direction: 'local_to_usdt', amount: '380000' });   // bob: 20000 UGX, 98.5 USDT
  ok('both funded (98.5 USDT / 20000 UGX each)', (await bal(alice, 'USDT')) === '98.500000' && (await bal(bob, 'UGX')) === '20000');

  console.log('USDT request → paid member-to-member');
  const r1 = await reqs.create({ requesterCustomerId: alice, currency: 'USDT', amount: '20', note: 'invoice #12' });
  ok('request open with a code', r1.status === 'open' && !!r1.code && r1.currency === 'USDT');
  const paid1 = await reqs.pay({ code: r1.code, payerCustomerId: bob });
  ok('delivered 20 USDT', paid1.amount === '20' && paid1.currency === 'USDT');
  ok('payer debited (78.5), requester credited (118.5)', (await bal(bob, 'USDT')) === '78.500000' && (await bal(alice, 'USDT')) === '118.500000');
  ok('request now paid', reqs.getByCode(r1.code)!.status === 'paid');

  console.log('local-currency request → paid in UGX');
  const r2 = await reqs.create({ requesterCustomerId: alice, currency: 'UGX', amount: '10000', note: 'lunch', country: 'UG' });
  await reqs.pay({ code: r2.code, payerCustomerId: bob });
  ok('UGX moved member-to-member', (await bal(bob, 'UGX')) === '10000' && (await bal(alice, 'UGX')) === '30000');

  console.log('guards');
  const ownReq = await reqs.create({ requesterCustomerId: alice, currency: 'USDT', amount: '1' });
  ok('paying your own request is rejected', await rejects(() => reqs.pay({ code: ownReq.code, payerCustomerId: alice })));
  ok('double pay is rejected', await rejects(() => reqs.pay({ code: r1.code, payerCustomerId: bob })));
  ok('unknown code is rejected', await rejects(() => reqs.pay({ code: 'NOPE', payerCustomerId: bob })));
  const big = await reqs.create({ requesterCustomerId: alice, currency: 'UGX', amount: '999999', country: 'UG' });
  ok('insufficient balance is rejected', await rejects(() => reqs.pay({ code: big.code, payerCustomerId: bob })));
  ok('zero amount is rejected', await rejects(() => reqs.create({ requesterCustomerId: alice, currency: 'USDT', amount: '0' })));

  console.log('international USDT account can pay a USDT request');
  const intl = 'cust:INTL:447700900000';
  const iw = await provisionWallet(ledger, intl, 'USDT', null);
  await ledger.postEntry({ entryType: 'usdt_topup', lines: [{ accountId: 'sys-USDT-hot', amount: '-100' }, { accountId: iw.id, amount: '100' }] });
  const r3 = await reqs.create({ requesterCustomerId: alice, currency: 'USDT', amount: '15' });
  await reqs.pay({ code: r3.code, payerCustomerId: intl });
  ok('international payer settled the USDT request', (await bal(intl, 'USDT')) === '85.000000' && (await bal(alice, 'USDT')) === '133.500000');

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
