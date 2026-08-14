/**
 * Per-market FX. Rate is expressed as units of local currency per 1 USDT
 * (e.g. UGX ~3800, KES ~129). Production swaps FixedFxRateProvider for a live
 * feed keyed the same way (profile.fxSource could name the feed per market).
 */
export interface FxRateProvider {
  /** Units of `localCurrency` per 1 USDT. */
  getLocalPerUsdt(localCurrency: string): Promise<string>;
}

export class FxRateUnavailableError extends Error {
  constructor(currency: string) { super(`No USDT rate available for ${currency}`); }
}

export class FixedFxRateProvider implements FxRateProvider {
  private rates: Record<string, string>;
  constructor(overrides: Record<string, string> = {}) {
    // Illustrative local-per-USDT rates across MTN MoMo's footprint. Swap for
    // a live per-market feed in production.
    this.rates = {
      KES: '129', UGX: '3800', GHS: '15.5', NGN: '1600', RWF: '1300',
      XOF: '600', XAF: '600', ZAR: '18.5', ZMW: '27', GNF: '8600',
      LRD: '190', SZL: '18.5', SSP: '5000', SDG: '600', USD: '1',
      ...overrides,
    };
  }
  async getLocalPerUsdt(localCurrency: string): Promise<string> {
    const r = this.rates[localCurrency];
    if (!r) throw new FxRateUnavailableError(localCurrency);
    return r;
  }
}
