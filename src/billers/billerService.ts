import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { LedgerStore } from '../ledger/store';
import { provisionWallet } from '../wallet/walletService';

/**
 * Bill pay / MoMoPay. A customer pays a biller or merchant from their local
 * wallet; funds move to the market's biller settlement pool. The market's
 * `merchantModel` (`momopay` for MTN markets, `paybill_till` for Kenya) is
 * surfaced so the UI can label it correctly, but the money movement is one
 * country-agnostic ledger entry. Biller directory is seeded per market here;
 * in production it's a hot-editable table (like billers in the M-Pesa build).
 */
export interface Biller { code: string; name: string; country: string; currency: string; category: string; }

export interface BillPayReceipt {
  ref: string; billerCode: string; billerName: string;
  amount: string; currency: string; model: string; at: number;
}

export class BillerError extends Error {}

const CATEGORIES: [string, string][] = [
  ['ELEC', 'Electricity'],
  ['WATER', 'Water & Sewerage'],
  ['TV', 'TV / Pay-per-view'],
  ['AIRTIME', 'Airtime top-up'],
  ['SCHOOL', 'School fees'],
];

export class BillerService {
  private billers = new Map<string, Biller>();
  private receipts: BillPayReceipt[] = [];

  constructor(private readonly ledger: LedgerStore, private readonly registry: CountryRegistry) {
    for (const p of registry.list()) {
      for (const [suf, name] of CATEGORIES) {
        const code = `${p.code}-${suf}`;
        this.billers.set(code, { code, name: `${name} · ${p.displayName}`, country: p.code, currency: p.localCurrency, category: name });
      }
    }
  }

  list(country?: string): Biller[] {
    const all = [...this.billers.values()];
    return country ? all.filter((b) => b.country === country.toUpperCase()) : all;
  }
  get(code: string): Biller | undefined { return this.billers.get(code.toUpperCase()); }

  async pay(p: { customerId: string; billerCode: string; amount: string }): Promise<BillPayReceipt> {
    const biller = this.get(p.billerCode);
    if (!biller) throw new BillerError(`Unknown biller "${p.billerCode}"`);
    const profile = this.registry.require(biller.country);
    if (!profile.features.merchantPay) throw new BillerError(`Merchant pay is not enabled for ${biller.country}`);
    const wallet = await provisionWallet(this.ledger, p.customerId, profile.localCurrency, profile.code);
    await this.ledger.assertSufficientBalance(wallet.id, p.amount);
    const ref = newId();
    await this.ledger.postEntry({
      entryType: 'bill_pay',
      idempotencyKey: `bill-${ref}`,
      lines: [
        { accountId: wallet.id, amount: `-${p.amount}` },
        { accountId: `sys-${profile.localCurrency}-biller`, amount: p.amount },
      ],
    });
    const receipt: BillPayReceipt = {
      ref, billerCode: biller.code, billerName: biller.name,
      amount: p.amount, currency: profile.localCurrency, model: profile.merchantModel, at: Date.now(),
    };
    this.receipts.unshift(receipt);
    this.receipts = this.receipts.slice(0, 100);
    return receipt;
  }
}
