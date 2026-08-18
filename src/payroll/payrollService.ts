import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { ProviderRegistry } from '../providers/registry';
import { LedgerStore } from '../ledger/store';
import { provisionWallet } from '../wallet/walletService';
import { toMsisdn } from '../context/phone';
import { RailError } from '../rail/railService';
import { PendingSettlements } from '../rail/settlement';

function suspenseId(currency: string): string { return `sys-${currency}-suspense`; }

export interface PayrollPayee {
  national: string;
  amountLocal: string;
  label?: string;
}

export interface PayrollItemResult extends PayrollPayee {
  status: 'paid' | 'pending' | 'failed';
  reference?: string;
  providerRef?: string;
  reason?: string;
}

export interface PayrollBatchResult {
  country: string;
  currency: string;
  paid: number;
  pending: number;
  failed: number;
  items: PayrollItemResult[];
}

/**
 * Bulk payout — one employer local wallet -> many workers' MoMo, via the
 * operator's Disbursements product. Maps directly onto MoMo `transfer`, and is
 * the wedge the pure on/off-ramps don't offer. Country-driven like everything
 * else: the currency, provider, and operator all come from the CountryProfile.
 * An employer holding USDT funds the local wallet first (deposit or convert) —
 * the diaspora-employer story generalises straight to every MoMo market.
 *
 * Money-safety (mirrors RailService.withdraw): each payee's funds are parked in
 * a per-currency suspense account BEFORE the disbursement is attempted, so they
 * can't be double-spent while in flight. A SUCCESSFUL disbursement moves
 * suspense->float; an immediate FAILED (or a provider error) reverses
 * suspense->employer; a PENDING (202 from real MoMo) is recorded in the shared
 * settlement store and later settled exactly once by the MoMo callback / status
 * poll — the same path deposits and withdrawals use. Nothing is disbursed
 * without the employer being debited first, and no in-flight item is silently
 * dropped as "failed".
 */
export class PayrollService {
  constructor(
    private readonly ledger: LedgerStore,
    private readonly registry: CountryRegistry,
    private readonly providers: ProviderRegistry,
    private readonly pending: PendingSettlements = new PendingSettlements(),
  ) {}

  async runBatch(countryCode: string, p: { employerCustomerId: string; payees: PayrollPayee[] }): Promise<PayrollBatchResult> {
    const profile = this.registry.require(countryCode);
    if (!profile.features.payroll) throw new RailError(`Payroll is not enabled for ${countryCode}`);
    const provider = this.providers.resolve(profile);
    const employerWallet = await provisionWallet(this.ledger, p.employerCustomerId, profile.localCurrency, profile.code);
    const susId = suspenseId(profile.localCurrency);

    const items: PayrollItemResult[] = [];
    let paid = 0, pending = 0, failed = 0;

    for (const payee of p.payees) {
      // Reject blank payee numbers outright — never silently pay a placeholder.
      const national = String(payee.national || '').trim();
      if (!national) {
        items.push({ ...payee, status: 'failed', reason: 'Missing payee phone number' });
        failed++;
        continue;
      }
      // Guard funds per item so a shortfall stops that payee, not the batch.
      try {
        await this.ledger.assertSufficientBalance(employerWallet.id, payee.amountLocal);
      } catch {
        items.push({ ...payee, status: 'failed', reason: 'Insufficient employer balance' });
        failed++;
        continue;
      }

      const msisdn = toMsisdn(profile, national);
      const reference = newId();

      // Hold: move the employer's funds into suspense before disbursing.
      await this.ledger.postEntry({
        entryType: 'payroll_hold',
        idempotencyKey: `payhold-${reference}`,
        lines: [
          { accountId: employerWallet.id, amount: `-${payee.amountLocal}` },
          { accountId: susId, amount: payee.amountLocal },
        ],
      });

      let res: { status: 'success' | 'pending' | 'failed'; providerRef?: string; failureReason?: string };
      try {
        res = await provider.disburse({ msisdn, amount: payee.amountLocal, currency: profile.localCurrency, reference });
      } catch (err: any) {
        // Provider threw before a terminal state -> reverse the hold, mark failed.
        await this.reverseHold(susId, employerWallet.id, payee.amountLocal, reference);
        items.push({ ...payee, status: 'failed', reference, reason: err && err.message ? err.message : 'Disbursement error' });
        failed++;
        continue;
      }

      if (res.status === 'success') {
        // Settle the hold: suspense -> operator float.
        await this.ledger.postEntry({
          entryType: 'payroll_disburse',
          idempotencyKey: `pay-${reference}`,
          lines: [
            { accountId: susId, amount: `-${payee.amountLocal}` },
            { accountId: profile.ledgerAccounts.localFloatId, amount: payee.amountLocal },
          ],
        });
        items.push({ ...payee, status: 'paid', reference, providerRef: res.providerRef });
        paid++;
      } else if (res.status === 'pending') {
        // Real MoMo 202: funds stay in suspense; the callback/status poll settles
        // this reference exactly once via the shared PendingSettlements store.
        this.pending.record({
          reference, kind: 'payroll', countryCode: profile.code, customerId: p.employerCustomerId,
          currency: profile.localCurrency, amountLocal: payee.amountLocal, walletId: employerWallet.id,
          floatId: profile.ledgerAccounts.localFloatId, suspenseId: susId, providerRef: res.providerRef,
        }, Date.now());
        items.push({ ...payee, status: 'pending', reference, providerRef: res.providerRef });
        pending++;
      } else {
        // Immediate failure -> reverse the hold back to the employer wallet.
        await this.reverseHold(susId, employerWallet.id, payee.amountLocal, reference);
        items.push({ ...payee, status: 'failed', reference, reason: res.failureReason });
        failed++;
      }
    }

    return { country: countryCode, currency: profile.localCurrency, paid, pending, failed, items };
  }

  private async reverseHold(susId: string, walletId: string, amountLocal: string, reference: string) {
    await this.ledger.postEntry({
      entryType: 'payroll_reversal',
      idempotencyKey: `payrev-${reference}`,
      lines: [
        { accountId: susId, amount: `-${amountLocal}` },
        { accountId: walletId, amount: amountLocal },
      ],
    });
  }
}
