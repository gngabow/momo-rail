import crypto from 'crypto';
import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { LedgerStore } from '../ledger/store';
import { provisionWallet } from '../wallet/walletService';

/**
 * "Request a payment": a customer raises a request (an amount in USDT or their
 * local currency, with a note) and shares a short code. Another signed-in
 * customer pays it, and the funds move member-to-member as a single balanced,
 * same-currency ledger entry — the rail's first P2P transfer primitive.
 *
 * USDT requests are payable by anyone holding USDT (including international,
 * USDT-only accounts). A local-currency request is settled by someone who holds
 * that market's currency — an unfunded payer simply fails the balance check.
 */
export type RequestStatus = 'open' | 'paid' | 'cancelled';

export interface PaymentRequest {
  id: string;
  code: string;
  requesterCustomerId: string;
  currency: string;          // 'USDT' or a market local currency
  country: string | null;    // market code for a local-currency request; null for USDT
  amount: string;
  note: string;
  status: RequestStatus;
  createdAt: number;
  paidAt?: number;
  payerCustomerId?: string;
}

export interface RequestSink {
  persist(r: PaymentRequest): Promise<void>;   // upsert by id
  loadOpen(): Promise<PaymentRequest[]>;         // still-open requests, for boot hydration
  init?(): Promise<void>;
}

export class RequestError extends Error {}

export class RequestService {
  private byId = new Map<string, PaymentRequest>();

  constructor(
    private readonly ledger: LedgerStore,
    private readonly registry: CountryRegistry,
    private readonly sink?: RequestSink,
  ) {}

  /** Load still-open requests from the durable sink (call once on boot). */
  async hydrate(): Promise<number> {
    if (!this.sink) return 0;
    const open = await this.sink.loadOpen();
    for (const r of open) this.byId.set(r.id, r);
    return open.length;
  }

  private save(r: PaymentRequest): PaymentRequest {
    this.byId.set(r.id, r);
    if (this.sink) this.sink.persist({ ...r }).catch((e) => console.error('[request] persist failed:', e && e.message ? e.message : e));
    return r;
  }

  private shortCode(): string { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

  /** Raise a payment request. `country` is required for a local-currency request. */
  async create(p: { requesterCustomerId: string; currency: string; amount: string; note?: string; country?: string | null }): Promise<PaymentRequest> {
    const currency = String(p.currency || '').toUpperCase();
    if (!(Number(p.amount) > 0)) throw new RequestError('Enter an amount greater than zero');
    let country: string | null = null;
    if (currency === 'USDT') {
      await provisionWallet(this.ledger, p.requesterCustomerId, 'USDT', null);
    } else {
      if (!p.country) throw new RequestError('A market is required for a local-currency request');
      const prof = this.registry.require(p.country); // throws on unknown/disabled
      if (prof.localCurrency !== currency) throw new RequestError(`${currency} is not the currency of ${prof.code}`);
      country = prof.code;
      await provisionWallet(this.ledger, p.requesterCustomerId, currency, country);
    }
    const req: PaymentRequest = {
      id: newId(), code: this.shortCode(), requesterCustomerId: p.requesterCustomerId,
      currency, country, amount: p.amount, note: String(p.note || ''), status: 'open', createdAt: Date.now(),
    };
    this.save(req);
    return req;
  }

  get(id: string): PaymentRequest | undefined { return this.byId.get(id); }
  getByCode(code: string): PaymentRequest | undefined {
    return [...this.byId.values()].find((r) => r.code.toUpperCase() === String(code || '').toUpperCase());
  }
  listFor(customerId: string): PaymentRequest[] {
    return [...this.byId.values()].filter((r) => r.requesterCustomerId === customerId).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Pay an open request: same-currency P2P transfer from payer to requester. */
  async pay(p: { code: string; payerCustomerId: string }): Promise<{ request: PaymentRequest; amount: string; currency: string }> {
    const req = this.getByCode(p.code) || this.get(p.code);
    if (!req) throw new RequestError('No such request');
    if (req.status !== 'open') throw new RequestError(`Request already ${req.status}`);
    if (req.requesterCustomerId === p.payerCustomerId) throw new RequestError("You can't pay your own request");

    const payer = await provisionWallet(this.ledger, p.payerCustomerId, req.currency, req.country);
    await this.ledger.assertSufficientBalance(payer.id, req.amount);
    const requester = await provisionWallet(this.ledger, req.requesterCustomerId, req.currency, req.country);

    await this.ledger.postEntry({
      entryType: 'p2p_request_pay',
      idempotencyKey: `req-pay-${req.id}`,
      lines: [
        { accountId: payer.id, amount: `-${req.amount}` },
        { accountId: requester.id, amount: req.amount },
      ],
    });

    req.status = 'paid'; req.paidAt = Date.now(); req.payerCustomerId = p.payerCustomerId;
    this.save(req);
    return { request: req, amount: req.amount, currency: req.currency };
  }
}
