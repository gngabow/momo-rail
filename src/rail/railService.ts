import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { ProviderRegistry } from '../providers/registry';
import { FxRateProvider } from '../fx/fxRateProvider';
import { LedgerStore } from '../ledger/store';
import { provisionWallet } from '../wallet/walletService';
import { toMsisdn } from '../context/phone';
import { screenTransaction } from '../compliance/screening';
import { ConversionDirection, createQuote, executeConversion, ConversionQuote } from '../exchange/exchange';
import { PendingSettlements, PendingSettlement } from './settlement';

export class RailError extends Error {}

function suspenseId(currency: string): string { return `sys-${currency}-suspense`; }

/**
 * The one code path that serves every market. Nothing here mentions KES, UGX or
 * a specific operator — it resolves the CountryProfile for the requested market
 * and reads currency, provider, fees, and compliance from it. Add a country =
 * add a CountryProfile row; this file never changes.
 */
export class RailService {
  constructor(
    private readonly ledger: LedgerStore,
    private readonly registry: CountryRegistry,
    private readonly providers: ProviderRegistry,
    private readonly fx: FxRateProvider,
    private readonly pending: PendingSettlements = new PendingSettlements(),
  ) {}

  /** The in-flight settlement store (deposits/withdrawals awaiting MoMo confirmation). */
  pendingStore(): PendingSettlements { return this.pending; }

  /** Money in: MoMo collection -> credit the customer's local wallet.
   * Mock/instant providers settle synchronously; a real MoMo `requesttopay`
   * returns pending (202) and settles later via `settle()` on the callback. */
  async deposit(countryCode: string, p: { customerId: string; national: string; amountLocal: string; sanctionsHit?: boolean }) {
    const profile = this.registry.require(countryCode);
    const provider = this.providers.resolve(profile);
    const screen = screenTransaction(profile, { customerId: p.customerId, amountLocal: p.amountLocal, sanctionsHit: p.sanctionsHit });
    if (screen.decision === 'block') throw new RailError(`Deposit blocked: ${screen.reason}`);

    const wallet = await provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    const msisdn = toMsisdn(profile, p.national);
    const reference = newId();
    const res = await provider.collect({ msisdn, amount: p.amountLocal, currency: profile.localCurrency, reference });

    if (res.status === 'success') {
      await this.creditDeposit(profile.ledgerAccounts.localFloatId, wallet.id, p.amountLocal, reference);
      return { status: 'completed' as const, reference, providerRef: res.providerRef, walletId: wallet.id, screen: screen.decision };
    }
    if (res.status === 'pending') {
      this.pending.record({
        reference, kind: 'deposit', countryCode: profile.code, customerId: p.customerId,
        currency: profile.localCurrency, amountLocal: p.amountLocal, walletId: wallet.id,
        floatId: profile.ledgerAccounts.localFloatId, providerRef: res.providerRef,
      }, Date.now());
      return { status: 'pending' as const, reference, providerRef: res.providerRef, walletId: wallet.id, screen: screen.decision };
    }
    return { status: res.status, reference, reason: res.failureReason, screen: screen.decision };
  }

  private async creditDeposit(floatId: string, walletId: string, amountLocal: string, reference: string) {
    await this.ledger.postEntry({
      entryType: 'momo_deposit',
      idempotencyKey: `dep-${reference}`,
      lines: [
        { accountId: floatId, amount: `-${amountLocal}` },
        { accountId: walletId, amount: amountLocal },
      ],
    });
  }

  /** Convert between the market's local currency and USDT, at its own FX + fee. */
  async convert(countryCode: string, p: { customerId: string; direction: ConversionDirection; amount: string })
    : Promise<{ quote: ConversionQuote; localWalletId: string; usdtWalletId: string }> {
    const profile = this.registry.require(countryCode);
    if (!profile.features.walletConvert) throw new RailError(`Convert is not enabled for ${countryCode}`);
    const localWallet = await provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    const usdtWallet = await provisionWallet(this.ledger, p.customerId, 'USDT', null);
    const quote = await createQuote(profile, this.fx, p.direction, p.amount);
    if (p.direction === 'local_to_usdt') await this.ledger.assertSufficientBalance(localWallet.id, quote.local);
    else await this.ledger.assertSufficientBalance(usdtWallet.id, quote.usdt);
    await executeConversion(this.ledger, profile, quote,
      { customerLocalAccountId: localWallet.id, customerUsdtAccountId: usdtWallet.id }, `cvt-${newId()}`);
    return { quote, localWalletId: localWallet.id, usdtWalletId: usdtWallet.id };
  }

  /** Money out: debit the customer's local wallet -> MoMo disbursement.
   * Funds are parked in a per-currency suspense account the instant the request
   * is accepted, so they can't be double-spent while the disbursement is in
   * flight. A confirmed SUCCESSFUL moves suspense->float; a FAILED reverses
   * suspense->wallet. Mock/instant providers do this inline; real MoMo does it
   * on the callback via `settle()`. */
  async withdraw(countryCode: string, p: { customerId: string; national: string; amountLocal: string }) {
    const profile = this.registry.require(countryCode);
    const provider = this.providers.resolve(profile);
    const wallet = await provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    await this.ledger.assertSufficientBalance(wallet.id, p.amountLocal);
    const msisdn = toMsisdn(profile, p.national);
    const reference = newId();
    const susId = suspenseId(profile.localCurrency);

    // Park the funds in suspense up front (hold).
    await this.ledger.postEntry({
      entryType: 'momo_withdraw_hold',
      idempotencyKey: `wdhold-${reference}`,
      lines: [
        { accountId: wallet.id, amount: `-${p.amountLocal}` },
        { accountId: susId, amount: p.amountLocal },
      ],
    });

    const res = await provider.disburse({ msisdn, amount: p.amountLocal, currency: profile.localCurrency, reference });

    if (res.status === 'success') {
      await this.settleWithdrawSuccess(susId, profile.ledgerAccounts.localFloatId, p.amountLocal, reference);
      return { status: 'completed' as const, reference, providerRef: res.providerRef };
    }
    if (res.status === 'pending') {
      this.pending.record({
        reference, kind: 'withdraw', countryCode: profile.code, customerId: p.customerId,
        currency: profile.localCurrency, amountLocal: p.amountLocal, walletId: wallet.id,
        floatId: profile.ledgerAccounts.localFloatId, suspenseId: susId, providerRef: res.providerRef,
      }, Date.now());
      return { status: 'pending' as const, reference, providerRef: res.providerRef };
    }
    // Immediate failure -> reverse the hold.
    await this.reverseWithdrawHold(susId, wallet.id, p.amountLocal, reference);
    return { status: res.status, reference, reason: res.failureReason };
  }

  private async settleWithdrawSuccess(susId: string, floatId: string, amountLocal: string, reference: string) {
    await this.ledger.postEntry({
      entryType: 'momo_withdraw',
      idempotencyKey: `wd-${reference}`,
      lines: [
        { accountId: susId, amount: `-${amountLocal}` },
        { accountId: floatId, amount: amountLocal },
      ],
    });
  }

  private async reverseWithdrawHold(susId: string, walletId: string, amountLocal: string, reference: string) {
    await this.ledger.postEntry({
      entryType: 'momo_withdraw_reversal',
      idempotencyKey: `wdrev-${reference}`,
      lines: [
        { accountId: susId, amount: `-${amountLocal}` },
        { accountId: walletId, amount: amountLocal },
      ],
    });
  }

  /**
   * Settle an in-flight deposit/withdraw from a MoMo callback or status poll.
   * Idempotent: a duplicate terminal event for an already-settled reference is a
   * no-op. Returns the settlement (or undefined if the reference is unknown).
   */
  async settle(reference: string, status: 'success' | 'failed', providerRef?: string, reason?: string): Promise<PendingSettlement | undefined> {
    const item = this.pending.get(reference);
    if (!item || item.status !== 'pending') return item;

    if (item.kind === 'deposit') {
      if (status === 'success') await this.creditDeposit(item.floatId, item.walletId, item.amountLocal, reference);
      // deposit failure: nothing was credited, just record the terminal state.
    } else {
      if (status === 'success') await this.settleWithdrawSuccess(item.suspenseId!, item.floatId, item.amountLocal, reference);
      else await this.reverseWithdrawHold(item.suspenseId!, item.walletId, item.amountLocal, reference);
    }
    return this.pending.markSettled(reference, status, Date.now(), providerRef, reason);
  }
}
