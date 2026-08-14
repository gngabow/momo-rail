import { toMinor, fromMinor, scaleOf, roundTo } from '../src/ledger/money';

describe('money (per-currency minor units)', () => {
  test('scale is per-currency', () => {
    expect(scaleOf('USDT')).toBe(6);
    expect(scaleOf('KES')).toBe(2);
    expect(scaleOf('UGX')).toBe(0); // Ugandan shilling has no minor unit
  });

  test('round-trips KES / USDT', () => {
    expect(toMinor('100.00', 'KES')).toBe(10000n);
    expect(fromMinor(10000n, 'KES')).toBe('100.00');
    expect(toMinor('5.500000', 'USDT')).toBe(5500000n);
    expect(fromMinor(5500000n, 'USDT')).toBe('5.500000');
  });

  test('UGX truncates sub-unit precision', () => {
    expect(toMinor('3800.99', 'UGX')).toBe(3800n);
    expect(fromMinor(3800n, 'UGX')).toBe('3800');
  });

  test('handles negatives', () => {
    expect(toMinor('-12.34', 'KES')).toBe(-1234n);
    expect(fromMinor(-1234n, 'KES')).toBe('-12.34');
  });

  test('roundTo formats to currency scale', () => {
    expect(roundTo(98.5, 'USDT')).toBe('98.500000');
    expect(roundTo(3800.4, 'UGX')).toBe('3800');
  });
});
