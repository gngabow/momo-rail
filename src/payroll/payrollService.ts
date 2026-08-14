import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { ProviderRegistry } from '../providers/registry';
import { LedgerStore } from '../ledger/store';
import { provisionWallet } from '../wallet/walletService';
import { toMsisdn } from '../context/phone';
import { RailError } from '../rail/railService';

export interface PayrollPayee {
  national: string;
  amountLocal: string;
  label?: string;
}

export interface PayrollItemResult extends PayrollPayee {
  status: 'paid' | 'failed';
  providerRef?: string;
  reason?: string;
}

export interface PayrollBatchResult {
  country: string;
  currency: string;
  paid: number;
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
 */
export class PayrollService {
  constructor(
    private readonly ledger: LedgerStore,
    private readonly registry: CountryRegistry,
    private readonly providers: ProviderRegistry,
  ) {}

  async runBatch(countryCode: string, p: { employerCustomerId: string; payees: PayrollPayee[] }): Promise<PayrollBatchResult> {
    const profile = this.registry.require(countryCode);
    if (!profile.features.payroll) throw new RailError(`Payroll is not enabled for ${countryCode}`);
    const provider = this.providers.resolve(profile);
    const employerWallet = await provisionWallet(this.ledger, p.employerCustomerId, profile.localCurrency, profile.code);

    const items: PayrollItemResult[] = [];
    let paid = 0, failed = 0;

    for (const payee of p.payees) {
      // Guard funds per item so a shortfall stops that payee, not the batch.
      try {
        await this.ledger.assertSufficientBalance(employerWallet.id, payee.amountLocal);
      } catch {
        items.push({ ...payee, status: 'failed', reason: 'Insufficient employer balance' });
        failed++;
        continue;
      }
      const msisdn = toMsisdn(profile, payee.national);
      const reference = newId();
      const res = await provider.disburse({ msisdn, amount: payee.amountLocal, currency: profile.localCurrency, reference });
      if (res.status === 'success') {
        await this.ledger.postEntry({
          entryType: 'payroll_disburse',
          idempotencyKey: `pay-${reference}`,
          lines: [
            { accountId: employerWallet.id, amount: `-${payee.amountLocal}` },
            { accountId: profile.ledgerAccounts.localFloatId, amount: payee.amountLocal },
          ],
        });
        items.push({ ...payee, status: 'paid', providerRef: res.providerRef });
        paid++;
      } else {
        items.push({ ...payee, status: 'failed', reason: res.failureReason });
        failed++;
      }
    }

    return { country: countryCode, currency: profile.localCurrency, paid, failed, items };
  }
}
