import { CountryProfile } from '../config/countryProfile';
import { FxRateProvider } from '../fx/fxRateProvider';
import { LedgerStore } from '../ledger/store';
import { fromMinor, roundTo, toMinor } from '../ledger/money';

/**
 * Country-driven convert: local currency <-> USDT at the market's own FX rate
 * and fee. The exact same code serves KES, UGX, GHS… — everything comes from
 * the CountryProfile and the FxRateProvider. Fee is booked in the target
 * currency (what the customer receives). Amounts are computed in minor units
 * so the resulting journal entry balances exactly.
 */

export type ConversionDirection = 'local_to_usdt' | 'usdt_to_local';

export interface ConversionQuote {
  direction: ConversionDirection;
  localCurrency: string;
  rateLocalPerUsdt: string;
  feeRate: number;
  local: string;          // local leg gross (flows through the local float)
  usdt: string;           // usdt leg gross (flows through the USDT hot wallet)
  fee: string;            // platform fee
  feeCurrency: string;
  net: string;            // delivered to the customer, in targetCurrency
  targetCurrency: string;
}

export interface ConversionAccounts {
  customerLocalAccountId: string;
  customerUsdtAccountId: string;
}

export async function createQuote(
  profile: CountryProfile,
  fx: FxRateProvider,
  direction: ConversionDirection,
  inputAmount: string,
): Promise<ConversionQuote> {
  const local = profile.localCurrency;
  const rate = await fx.getLocalPerUsdt(local);
  const R = Number(rate);
  const feeRate = profile.feeSchedule.convertRate;

  if (direction === 'local_to_usdt') {
    const Lminor = toMinor(roundTo(Number(inputAmount), local), local);
    const grossUsdtNum = Number(fromMinor(Lminor, local)) / R;
    const grossUsdtMinor = toMinor(roundTo(grossUsdtNum, 'USDT'), 'USDT');
    const feeMinor = toMinor(roundTo(grossUsdtNum * feeRate, 'USDT'), 'USDT');
    const netMinor = grossUsdtMinor - feeMinor;
    return {
      direction, localCurrency: local, rateLocalPerUsdt: rate, feeRate,
      local: fromMinor(Lminor, local),
      usdt: fromMinor(grossUsdtMinor, 'USDT'),
      fee: fromMinor(feeMinor, 'USDT'), feeCurrency: 'USDT',
      net: fromMinor(netMinor, 'USDT'), targetCurrency: 'USDT',
    };
  } else {
    const Uminor = toMinor(roundTo(Number(inputAmount), 'USDT'), 'USDT');
    const grossLocalNum = Number(fromMinor(Uminor, 'USDT')) * R;
    const grossLocalMinor = toMinor(roundTo(grossLocalNum, local), local);
    const feeMinor = toMinor(roundTo(grossLocalNum * feeRate, local), local);
    const netMinor = grossLocalMinor - feeMinor;
    return {
      direction, localCurrency: local, rateLocalPerUsdt: rate, feeRate,
      local: fromMinor(grossLocalMinor, local),
      usdt: fromMinor(Uminor, 'USDT'),
      fee: fromMinor(feeMinor, local), feeCurrency: local,
      net: fromMinor(netMinor, local), targetCurrency: local,
    };
  }
}

export function executeConversion(
  ledger: LedgerStore,
  profile: CountryProfile,
  quote: ConversionQuote,
  accounts: ConversionAccounts,
  idempotencyKey?: string,
) {
  const sys = profile.ledgerAccounts;
  if (quote.direction === 'local_to_usdt') {
    return ledger.postEntry({
      entryType: 'convert_local_to_usdt',
      idempotencyKey,
      lines: [
        { accountId: accounts.customerLocalAccountId, amount: `-${quote.local}` },
        { accountId: sys.localFloatId, amount: quote.local },
        { accountId: accounts.customerUsdtAccountId, amount: quote.net },
        { accountId: sys.usdtFeeRevenueId, amount: quote.fee },
        { accountId: sys.usdtHotWalletId, amount: `-${quote.usdt}` },
      ],
    });
  }
  return ledger.postEntry({
    entryType: 'convert_usdt_to_local',
    idempotencyKey,
    lines: [
      { accountId: accounts.customerUsdtAccountId, amount: `-${quote.usdt}` },
      { accountId: sys.usdtHotWalletId, amount: quote.usdt },
      { accountId: accounts.customerLocalAccountId, amount: quote.net },
      { accountId: sys.localFeeRevenueId, amount: quote.fee },
      { accountId: sys.localFloatId, amount: `-${quote.local}` },
    ],
  });
}
