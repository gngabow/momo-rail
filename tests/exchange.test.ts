import { seedProfiles } from '../src/config/countryProfile';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { createQuote } from '../src/exchange/exchange';

const profiles = seedProfiles();
const UG = profiles.find((p) => p.code === 'UG')!;
const KE = profiles.find((p) => p.code === 'KE')!;
const fx = new FixedFxRateProvider();

describe('exchange (country-driven convert)', () => {
  test('UGX -> USDT applies market rate and 1.5% fee', async () => {
    const q = await createQuote(UG, fx, 'local_to_usdt', '380000'); // 380000 UGX @ 3800 = 100 USDT
    expect(q.usdt).toBe('100.000000');
    expect(q.fee).toBe('1.500000');
    expect(q.net).toBe('98.500000');
    expect(q.targetCurrency).toBe('USDT');
  });

  test('USDT -> UGX applies fee in local currency', async () => {
    const q = await createQuote(UG, fx, 'usdt_to_local', '100'); // 100 USDT @ 3800 = 380000 UGX
    expect(q.local).toBe('380000');
    expect(q.fee).toBe('5700');     // 1.5% of 380000
    expect(q.net).toBe('374300');
    expect(q.targetCurrency).toBe('UGX');
  });

  test('KES -> USDT reaches the same USDT on the same code path', async () => {
    const q = await createQuote(KE, fx, 'local_to_usdt', '12900'); // 12900 KES @ 129 = 100 USDT
    expect(q.net).toBe('98.500000');
    expect(q.feeCurrency).toBe('USDT');
  });
});
