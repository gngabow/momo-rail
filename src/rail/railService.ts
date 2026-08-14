import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { ProviderRegistry } from '../providers/registry';
import { FxRateProvider } from '../fx/fxRateProvider';
import { Ledger } from '../ledger/ledger';
import { provisionWallet } from '../wallet/walletService';
import { toMsisdn } from '../context/phone';
import { screenTransaction } from '../compliance/screening';
import { ConversionDirection, createQuote, executeConversion, ConversionQuote } from '../exchange/exchange';

export class RailError extends Error {}

/**
 * The one code path that serves every market. Nothing here mentions KES, UGX or
 * a specific operator — it resolves the CountryProfile for the requested market
 * and reads currency, provider, fees, and compliance from it. Add a country =
 * add a CountryProfile row; this file never changes.
 */
export class RailService {
  constructor(
    private readonly ledger: Ledger,
    private readonly registry: CountryRegistry,
    private readonly providers: ProviderRegistry,
    private readonly fx: FxRateProvider,
  ) {}

  /** Money in: MoMo collection -> credit the customer's local wallet. */
  async deposit(countryCode: string, p: { customerId: string; national: string; amountLocal: string; sanctionsHit?: boolean }) {
    const profile = this.registry.require(countryCode);
    const provider = this.providers.resolve(profile);
    const screen = screenTransaction(profile, { customerId: p.customerId, amountLocal: p.amountLocal, sanctionsHit: p.sanctionsHit });
    if (screen.decision === 'block') throw new RailError(`Deposit blocked: ${screen.reason}`);

    const wallet = provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    const msisdn = toMsisdn(profile, p.national);
    const reference = newId();
    const res = await provider.collect({ msisdn, amount: p.amountLocal, currency: profile.localCurrency, reference });
    if (res.status === 'success') {
      this.ledger.postEntry({
        entryType: 'momo_deposit',
        idempotencyKey: `dep-${reference}`,
        lines: [
          { accountId: profile.ledgerAccounts.localFloatId, amount: `-${p.amountLocal}` },
          { accountId: wallet.id, amount: p.amountLocal },
        ],
      });
      return { status: 'completed' as const, reference, providerRef: res.providerRef, walletId: wallet.id, screen: screen.decision };
    }
    return { status: res.status, reference, reason: res.failureReason, screen: screen.decision };
  }

  /** Convert between the market's local currency and USDT, at its own FX + fee. */
  async convert(countryCode: string, p: { customerId: string; direction: ConversionDirection; amount: string })
    : Promise<{ quote: ConversionQuote; localWalletId: string; usdtWalletId: string }> {
    const profile = this.registry.require(countryCode);
    if (!profile.features.walletConvert) throw new RailError(`Convert is not enabled for ${countryCode}`);
    const localWallet = provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    const usdtWallet = provisionWallet(this.ledger, p.customerId, 'USDT', null);
    const quote = await createQuote(profile, this.fx, p.direction, p.amount);
    if (p.direction === 'local_to_usdt') this.ledger.assertSufficientBalance(localWallet.id, quote.local);
    else this.ledger.assertSufficientBalance(usdtWallet.id, quote.usdt);
    executeConversion(this.ledger, profile, quote,
      { customerLocalAccountId: localWallet.id, customerUsdtAccountId: usdtWallet.id }, `cvt-${newId()}`);
    return { quote, localWalletId: localWallet.id, usdtWalletId: usdtWallet.id };
  }

  /** Money out: debit the customer's local wallet -> MoMo disbursement. */
  async withdraw(countryCode: string, p: { customerId: string; national: string; amountLocal: string }) {
    const profile = this.registry.require(countryCode);
    const provider = this.providers.resolve(profile);
    const wallet = provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    this.ledger.assertSufficientBalance(wallet.id, p.amountLocal);
    const msisdn = toMsisdn(profile, p.national);
    const reference = newId();
    const res = await provider.disburse({ msisdn, amount: p.amountLocal, currency: profile.localCurrency, reference });
    if (res.status === 'success') {
      this.ledger.postEntry({
        entryType: 'momo_withdraw',
        idempotencyKey: `wd-${reference}`,
        lines: [
          { accountId: wallet.id, amount: `-${p.amountLocal}` },
          { accountId: profile.ledgerAccounts.localFloatId, amount: p.amountLocal },
        ],
      });
      return { status: 'completed' as const, reference, providerRef: res.providerRef };
    }
    return { status: res.status, reference, reason: res.failureReason };
  }
}
