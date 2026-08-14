/**
 * CountryProfile — the heart of "configurable country by country". One record
 * per market holds everything a Kenya-only build would hardcode. Downstream
 * services never ask "is this KES?"; they resolve the active CountryProfile and
 * read currency, provider, fees, and compliance from it.
 *
 * In-memory registry here; in production this is a DB table, hot-editable from
 * the ops console (same pattern as a biller directory).
 */

export interface FeeSchedule {
  convertRate: number;    // e.g. 0.015
  remittanceRate: number; // e.g. 0.02
  merchantPayRate: number;
}

export interface CountryLedgerAccounts {
  localFloatId: string;
  localFeeRevenueId: string;
  usdtHotWalletId: string;     // may be shared across markets
  usdtFeeRevenueId: string;    // may be shared across markets
}

export interface CountryFeatures {
  walletConvert: boolean;
  inboundRemittance: boolean;
  outboundRemittance: boolean;
  payroll: boolean;
  merchantPay: boolean;
  agents: boolean;
}

export interface CountryProfile {
  code: string;            // ISO-3166-1 alpha-2
  displayName: string;
  enabled: boolean;

  // Money & identity
  localCurrency: string;
  dialCode: string;
  phoneRegex: string;      // national-number validation for this market
  msisdnFormat: 'bare' | 'plus';

  // Rail adapter
  momoOperator: string;    // e.g. "MTN_UG"
  providerKey: string;     // resolves an adapter: "momo" | "daraja" | "momo_mock"
  providerEnv: 'sandbox' | 'production';

  // Economics
  feeSchedule: FeeSchedule;
  limits: { perTxMaxLocal: string };
  ledgerAccounts: CountryLedgerAccounts;

  // Products
  features: CountryFeatures;
  merchantModel: 'momopay' | 'paybill_till' | 'none';

  // Compliance & licensing
  kycProviderKey: string;
  sanctionsProviderKey: string;
  screening: { reviewThresholdLocal: string; blockOnSanctionsHit: boolean };
  licensing: { vaspLicensed: boolean; regime: string; note: string };
}

export class CountryDisabledError extends Error {
  constructor(code: string) { super(`Country "${code}" is not enabled on this rail`); }
}
export class CountryNotFoundError extends Error {
  constructor(code: string) { super(`No CountryProfile for "${code}"`); }
}

export class CountryRegistry {
  private profiles = new Map<string, CountryProfile>();

  upsert(p: CountryProfile): void {
    this.profiles.set(p.code.toUpperCase(), p);
  }

  get(code: string): CountryProfile {
    const p = this.profiles.get(code.toUpperCase());
    if (!p) throw new CountryNotFoundError(code);
    return p;
  }

  /** Resolve an *active* profile — the entry point money-movement code uses. */
  require(code: string): CountryProfile {
    const p = this.get(code);
    if (!p.enabled) throw new CountryDisabledError(code);
    return p;
  }

  list(): CountryProfile[] {
    return [...this.profiles.values()];
  }
}

const SHARED_USDT_HOT = 'sys-USDT-hot';
const SHARED_USDT_FEEREV = 'sys-USDT-feerev';

/** Compact seed table: MTN MoMo's African footprint. `tested` marks the markets
 * wired end-to-end today.
 * Currencies with no minor unit (XOF, XAF, RWF, UGX, GNF) exercise scale-0
 * money handling; the rest are scale-2. FX rates are illustrative (see
 * fxRateProvider). System ledger accounts are keyed by currency, so markets
 * sharing a currency (XOF: CI/BJ/GW; XAF: CM/CG) share one float. */
interface MarketSeed {
  code: string; name: string; currency: string; dial: string;
  phoneRegex?: string; merchantModel?: CountryProfile['merchantModel'];
  operator?: string; tested?: boolean;
}

const MOMO_MARKETS: MarketSeed[] = [
  { code: 'UG', name: 'Uganda', currency: 'UGX', dial: '256', phoneRegex: '^7\\d{8}$', tested: true },
  { code: 'GH', name: 'Ghana', currency: 'GHS', dial: '233' },
  { code: 'CI', name: 'Côte d’Ivoire', currency: 'XOF', dial: '225' },
  { code: 'CM', name: 'Cameroon', currency: 'XAF', dial: '237' },
  { code: 'NG', name: 'Nigeria', currency: 'NGN', dial: '234' },
  { code: 'RW', name: 'Rwanda', currency: 'RWF', dial: '250' },
  { code: 'ZM', name: 'Zambia', currency: 'ZMW', dial: '260' },
  { code: 'BJ', name: 'Benin', currency: 'XOF', dial: '229' },
  { code: 'CG', name: 'Congo-Brazzaville', currency: 'XAF', dial: '242' },
  { code: 'GN', name: 'Guinea', currency: 'GNF', dial: '224' },
  { code: 'GW', name: 'Guinea-Bissau', currency: 'XOF', dial: '245' },
  { code: 'LR', name: 'Liberia', currency: 'LRD', dial: '231' },
  { code: 'SZ', name: 'Eswatini', currency: 'SZL', dial: '268' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR', dial: '27' },
  { code: 'SS', name: 'South Sudan', currency: 'SSP', dial: '211' },
];

function toProfile(m: MarketSeed): CountryProfile {
  return {
    code: m.code,
    displayName: m.name,
    enabled: true,
    localCurrency: m.currency,
    dialCode: m.dial,
    phoneRegex: m.phoneRegex ?? '^\\d{7,12}$',
    msisdnFormat: 'bare',
    momoOperator: m.operator ?? `MTN_${m.code}`,
    providerKey: 'momo_mock', // production: 'momo' (per MTN OpCo)
    providerEnv: 'sandbox',
    feeSchedule: { convertRate: 0.015, remittanceRate: 0.02, merchantPayRate: 0 },
    limits: { perTxMaxLocal: '1000000000' },
    ledgerAccounts: {
      localFloatId: `sys-${m.currency}-float`,
      localFeeRevenueId: `sys-${m.currency}-feerev`,
      usdtHotWalletId: SHARED_USDT_HOT,
      usdtFeeRevenueId: SHARED_USDT_FEEREV,
    },
    features: { walletConvert: true, inboundRemittance: true, outboundRemittance: true, payroll: true, merchantPay: true, agents: true },
    merchantModel: m.merchantModel ?? 'momopay',
    kycProviderKey: 'mock',
    sanctionsProviderKey: 'mock',
    screening: { reviewThresholdLocal: '5000000', blockOnSanctionsHit: true },
    // No market is licensed yet — the regime/note distinguishes "wired today"
    // from "config-ready, awaiting OpCo access + licence". Flipping a market
    // legally live is a data change, not a code change.
    licensing: m.tested
      ? { vaspLicensed: false, regime: `${m.code}-pilot`, note: 'Wired & tested end-to-end' }
      : { vaspLicensed: false, regime: `${m.code}-config`, note: 'Config-ready; awaiting OpCo access + licence' },
  };
}

/** Every MoMo market as a profile. The same code path runs all of them (against
 * the mock adapter) today; production swaps providerKey per operating company. */
export function seedProfiles(): CountryProfile[] {
  return MOMO_MARKETS.map(toProfile);
}
