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
export interface Biller { code: string; name: string; country: string; currency: string; category: string; enabled: boolean; }

export interface BillPayReceipt {
  ref: string; billerCode: string; billerName: string;
  amount: string; currency: string; model: string; at: number;
}

export class BillerError extends Error {}

export interface BillerSink {
  persistBiller(b: Biller): Promise<void>;               // upsert an edited/custom biller
  persistReceipt(r: BillPayReceipt): Promise<void>;      // append a bill-pay receipt (audit)
  loadBillers(): Promise<Biller[]>;                      // persisted (admin-edited) billers
  loadReceipts(limit: number): Promise<BillPayReceipt[]>; // recent receipts, newest first
  init?(): Promise<void>;
}

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

  constructor(
    private readonly ledger: LedgerStore,
    private readonly registry: CountryRegistry,
    private readonly sink?: BillerSink,
  ) {
    for (const p of registry.list()) {
      for (const [suf, name] of CATEGORIES) {
        const code = `${p.code}-${suf}`;
        this.billers.set(code, { code, name: `${name} · ${p.displayName}`, country: p.code, currency: p.localCurrency, category: name, enabled: true });
      }
    }
  }

  /** Load admin-edited billers and recent receipts from the durable sink (call once on boot).
   *  Persisted billers overwrite the deterministic seed set by code. */
  async hydrate(): Promise<number> {
    if (!this.sink) return 0;
    const saved = await this.sink.loadBillers();
    for (const b of saved) this.billers.set(b.code.toUpperCase(), b);
    this.receipts = await this.sink.loadReceipts(100);
    return saved.length;
  }

  private flushBiller(b: Biller): void {
    if (this.sink) this.sink.persistBiller({ ...b }).catch((e) => console.error('[biller] persist failed:', e && e.message ? e.message : e));
  }

  /** Customer-facing list: only enabled billers, optionally scoped to a market. */
  list(country?: string): Biller[] {
    const all = [...this.billers.values()].filter((b) => b.enabled);
    return country ? all.filter((b) => b.country === country.toUpperCase()) : all;
  }
  /** Admin list: every biller including disabled ones. */
  listAll(country?: string): Biller[] {
    const all = [...this.billers.values()];
    return country ? all.filter((b) => b.country === country.toUpperCase()) : all;
  }
  get(code: string): Biller | undefined { return this.billers.get(code.toUpperCase()); }

  /** Admin: create or update a biller (name/category/enabled). Country+currency are
   * resolved from the market so a biller can't reference an unknown currency. */
  upsert(p: { code: string; name: string; country: string; category?: string; enabled?: boolean }): Biller {
    const profile = this.registry.get(p.country); // throws on unknown market
    const code = p.code.toUpperCase();
    const existing = this.billers.get(code);
    const biller: Biller = {
      code,
      name: p.name || existing?.name || code,
      country: profile.code,
      currency: profile.localCurrency,
      category: p.category ?? existing?.category ?? 'Other',
      enabled: p.enabled ?? existing?.enabled ?? true,
    };
    this.billers.set(code, biller);
    this.flushBiller(biller);
    return biller;
  }

  /** Admin: enable/disable a biller without deleting it. */
  setEnabled(code: string, enabled: boolean): Biller {
    const b = this.get(code);
    if (!b) throw new BillerError(`Unknown biller "${code}"`);
    b.enabled = enabled;
    this.flushBiller(b);
    return b;
  }

  async pay(p: { customerId: string; billerCode: string; amount: string }): Promise<BillPayReceipt> {
    const biller = this.get(p.billerCode);
    if (!biller) throw new BillerError(`Unknown biller "${p.billerCode}"`);
    if (!biller.enabled) throw new BillerError(`Biller "${biller.code}" is disabled`);
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
    if (this.sink) this.sink.persistReceipt({ ...receipt }).catch((e) => console.error('[biller] receipt persist failed:', e && e.message ? e.message : e));
    return receipt;
  }
}
