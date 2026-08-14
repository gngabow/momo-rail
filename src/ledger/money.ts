/**
 * Minor-unit money math. Amounts move through the API as decimal strings in
 * major units ("100.00", "5.500000"); internally the ledger works in integer
 * minor units (bigint) so balancing is exact with no float drift. Currency
 * scale is a property of the currency (USDT=6, KES=2, UGX=0 — the Ugandan
 * shilling has no minor unit, which is exactly why scale must be per-currency).
 */
const SCALE: Record<string, number> = {
  USDT: 6, USDC: 6,
  KES: 2, GHS: 2, NGN: 2, USD: 2, EUR: 2, GBP: 2, ZAR: 2,
  ZMW: 2, LRD: 2, SZL: 2, SDG: 2, SSP: 2,
  UGX: 0, RWF: 0, XOF: 0, XAF: 0, GNF: 0,
};

export function scaleOf(currency: string): number {
  return SCALE[currency] ?? 2;
}

/** Parse a decimal-string major amount into integer minor units (truncating
 * any precision beyond the currency scale). */
export function toMinor(amount: string, currency: string): bigint {
  const scale = scaleOf(currency);
  const t = amount.trim();
  const neg = t.startsWith('-');
  const clean = t.replace(/^[-+]/, '');
  if (!/^\d*(\.\d*)?$/.test(clean)) throw new Error(`Invalid money amount: "${amount}"`);
  const [intPart, fracRaw = ''] = clean.split('.');
  const frac = (fracRaw + '0'.repeat(scale)).slice(0, scale);
  const digits = ((intPart || '0') + frac).replace(/^0+(?=\d)/, '') || '0';
  const v = BigInt(digits);
  return neg ? -v : v;
}

/** Format integer minor units back into a decimal-string major amount. */
export function fromMinor(minor: bigint, currency: string): string {
  const scale = scaleOf(currency);
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(scale + 1, '0');
  const intPart = abs.slice(0, abs.length - scale) || '0';
  const frac = scale > 0 ? '.' + abs.slice(abs.length - scale) : '';
  return (neg ? '-' : '') + intPart + frac;
}

/** Round a JS number to a currency's scale and return the decimal string. */
export function roundTo(amount: number, currency: string): string {
  return amount.toFixed(scaleOf(currency));
}
