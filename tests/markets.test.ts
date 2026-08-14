import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { scaleOf } from '../src/ledger/money';

describe('every MoMo market runs on one code path', () => {
  test('deposit + convert works for the full configured footprint', async () => {
    const { ledger, registry } = bootstrap();
    const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());
    const markets = registry.list();
    const currencies = new Set<string>();

    for (const p of markets) {
      const s0 = scaleOf(p.localCurrency) === 0;
      await rail.deposit(p.code, { customerId: `c-${p.code}`, national: '700000001', amountLocal: s0 ? '1000000' : '100000.00' });
      const cvt = await rail.convert(p.code, { customerId: `c-${p.code}`, direction: 'local_to_usdt', amount: s0 ? '500000' : '50000.00' });
      expect(Number(ledger.getBalance(cvt.usdtWalletId).balance)).toBeGreaterThan(0);
      currencies.add(p.localCurrency);
    }

    expect(markets.length).toBeGreaterThanOrEqual(15);
    expect(currencies.size).toBeGreaterThanOrEqual(10);
  });
});
