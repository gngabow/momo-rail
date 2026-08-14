/**
 * International (non-Opco) USDT customer path.
 * Run: `ts-node -T tests/verify-intl.ts`.
 * Covers: intl OTP sign-in → USDT-only identity; funding USDT; running gig-worker
 * payroll into an Opco (USDT → local convert, then disburse); and remitting to an Opco.
 */
import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { PayrollService } from '../src/payroll/payrollService';
import { ClaimStore } from '../src/remittance/claimStore';
import { RemittanceService } from '../src/remittance/remittanceService';
import { AuthService, isIntlCustomer, customerIdFor } from '../src/auth/authService';
import { CountryRegistry, seedProfiles } from '../src/config/countryProfile';
import { provisionWallet } from '../src/wallet/walletService';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function freshRegistry(): CountryRegistry {
  const r = new CountryRegistry();
  for (const p of seedProfiles()) r.upsert(p);
  return r;
}

async function main() {
  console.log('\nintl auth (non-Opco number → USDT-only identity)');
  {
    const auth = new AuthService(freshRegistry());
    const req = auth.requestOtpIntl('+44 7911 123456');
    ok('intl OTP issued with dev code', !!req.devCode && req.intl === true);
    const v = auth.verifyOtpIntl('+44 7911 123456', req.devCode!);
    ok('intl verify → token + intl customer id', v.intl === true && v.customerId === customerIdFor('INTL', '447911123456'));
    ok('isIntlCustomer detects it', isIntlCustomer(v.customerId) && !isIntlCustomer('cust:UG:256772'));
  }

  console.log('intl operations (fund USDT → payroll into an Opco → remit)');
  {
    const { ledger, registry } = await bootstrap();
    const providers = new ProviderRegistry();
    const fx = new FixedFxRateProvider();
    const rail = new RailService(ledger, registry, providers, fx);
    const payroll = new PayrollService(ledger, registry, providers);
    const remit = new RemittanceService(ledger, registry, fx, new ClaimStore());
    const intl = customerIdFor('INTL', '447911123456');

    // Fund the international customer's USDT (top-up).
    const uw = await provisionWallet(ledger, intl, 'USDT', null);
    await ledger.postEntry({ entryType: 'usdt_topup', lines: [{ accountId: 'sys-USDT-hot', amount: '-2500' }, { accountId: uw.id, amount: '2500' }] });
    const usdtBal = async () => (await ledger.getBalance((await ledger.findCustomerWallet(intl, 'USDT'))!.id)).balance;
    ok('international customer holds 2500 USDT', (await usdtBal()) === '2500.000000');

    // Gig Workers Payroll into Kenya: convert USDT → KES, then disburse.
    const cvt = await rail.convert('KE', { customerId: intl, direction: 'usdt_to_local', amount: '100' });
    ok('USDT→KES convert nets 12706.50 KES', cvt.quote.net === '12706.50');
    const kesBal = async () => (await ledger.getBalance((await ledger.findCustomerWallet(intl, 'KES'))!.id)).balance;
    ok('intl customer now holds KES for payout', (await kesBal()) === '12706.50');
    const run = await payroll.runBatch('KE', { employerCustomerId: intl, payees: [
      { national: '712000001', amountLocal: '5000' },
      { national: '712000002', amountLocal: '5000' },
    ]});
    ok('paid 2 gig workers from converted USDT', run.paid === 2 && run.failed === 0);
    ok('remaining KES after payroll', (await kesBal()) === '2706.50');

    // Remit to an Opco recipient.
    const sent = await remit.send({ senderCustomerId: intl, destCountry: 'UG', destNational: '772000111', amountUsdt: '50' });
    ok('intl remit reserved to Opco', sent.claim.status === 'reserved');
    ok('USDT debited (2500 - 100 convert - 50 remit = 2350)', (await usdtBal()) === '2350.000000');
  }

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
