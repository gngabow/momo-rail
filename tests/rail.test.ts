import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService, RailError } from '../src/rail/railService';
import { InsufficientBalanceError } from '../src/ledger/ledger';

function makeRail() {
  const { ledger, registry } = bootstrap();
  const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());
  return { ledger, registry, rail };
}

// The headline proof: identical code, two markets, two currencies.
const MARKETS = [
  { country: 'UG', national: '772123456', currency: 'UGX', deposit: '400000', convert: '380000' },
  { country: 'KE', national: '712345678', currency: 'KES', deposit: '20000', convert: '12900' },
] as const;

describe.each(MARKETS)('rail end-to-end · $country ($currency)', (m) => {
  test('deposit credits the local wallet', async () => {
    const { ledger, rail } = makeRail();
    const dep = await rail.deposit(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit });
    expect(dep.status).toBe('completed');
    expect(ledger.getBalance(dep.walletId!).balance).toBe(
      m.currency === 'UGX' ? '400000' : '20000.00',
    );
  });

  test('convert local -> USDT lands the same 98.5 USDT on both markets', async () => {
    const { ledger, rail } = makeRail();
    await rail.deposit(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit });
    const cvt = await rail.convert(m.country, { customerId: 'c1', direction: 'local_to_usdt', amount: m.convert });
    expect(cvt.quote.net).toBe('98.500000');
    expect(ledger.getBalance(cvt.usdtWalletId).balance).toBe('98.500000');
  });

  test('withdraw disburses and debits the local wallet', async () => {
    const { ledger, rail } = makeRail();
    await rail.deposit(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit });
    const wd = await rail.withdraw(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit });
    expect(wd.status).toBe('completed');
    // full balance withdrawn -> back to zero
    const walletBal = ledger.getBalance(ledger.findCustomerWallet('c1', m.currency)!.id).balance;
    expect(walletBal).toBe(m.currency === 'UGX' ? '0' : '0.00');
  });

  test('withdrawing more than the balance is rejected', async () => {
    const { rail } = makeRail();
    await rail.deposit(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit });
    await expect(
      rail.withdraw(m.country, { customerId: 'c1', national: m.national, amountLocal: m.deposit + '0' }),
    ).rejects.toThrow(InsufficientBalanceError);
  });
});

describe('rail guards', () => {
  test('a declined MoMo prompt leaves no balance', async () => {
    const { ledger, rail } = makeRail();
    const dep = await rail.deposit('KE', { customerId: 'c9', national: '712340000', amountLocal: '5000' }); // msisdn ends 0000 -> mock declines
    expect(dep.status).toBe('failed');
    expect(ledger.findCustomerWallet('c9', 'KES')?.id).toBeDefined();
    expect(ledger.getBalance(ledger.findCustomerWallet('c9', 'KES')!.id).balance).toBe('0.00');
  });

  test('a sanctions hit blocks the deposit', async () => {
    const { rail } = makeRail();
    await expect(
      rail.deposit('UG', { customerId: 'c1', national: '772123456', amountLocal: '100000', sanctionsHit: true }),
    ).rejects.toThrow(RailError);
  });

  test('an unknown/disabled country is rejected', async () => {
    const { rail } = makeRail();
    await expect(rail.deposit('ZZ', { customerId: 'c1', national: '700000000', amountLocal: '1000' })).rejects.toThrow();
  });
});
