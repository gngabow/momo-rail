/**
 * Remittance claim store. A "reserve now, deliver on signup" claim: the sender's
 * funds sit in USDT escrow (a durable ledger account) until the recipient — who
 * may not be registered yet — claims them. In-memory map with an optional
 * write-through durable sink (Postgres) hydrated on boot, so a restart doesn't
 * lose the reservation and strand escrow funds.
 */
export type ClaimStatus = 'reserved' | 'claimed' | 'cancelled';

export interface RemittanceClaim {
  id: string;
  code: string;                 // short human-shareable claim code
  senderCustomerId: string;
  destCountry: string;          // ISO code (upper)
  destMsisdn: string;           // canonical bare MSISDN
  amountUsdt: string;
  status: ClaimStatus;
  createdAt: number;
  claimedAt?: number;
  deliveredLocal?: string;
  deliveredCurrency?: string;
  // Outbound-to-international (non-Opco) claims: destCountry is 'INTL', delivered
  // in USDT (no local conversion). recipientType labels C2C vs C2B.
  recipientType?: 'person' | 'business';
  destLabel?: string;
}

export interface ClaimSink {
  persist(c: RemittanceClaim): Promise<void>;   // upsert by id
  loadOpen(): Promise<RemittanceClaim[]>;        // reserved claims, for boot hydration
  init?(): Promise<void>;
}

export class ClaimStore {
  private byId = new Map<string, RemittanceClaim>();

  constructor(private readonly sink?: ClaimSink) {}

  async hydrate(): Promise<number> {
    if (!this.sink) return 0;
    const open = await this.sink.loadOpen();
    for (const c of open) this.byId.set(c.id, c);
    return open.length;
  }

  add(c: RemittanceClaim): RemittanceClaim { this.byId.set(c.id, c); this.flush(c); return c; }
  update(c: RemittanceClaim): RemittanceClaim { this.byId.set(c.id, c); this.flush(c); return c; }
  get(id: string): RemittanceClaim | undefined { return this.byId.get(id); }
  getByCode(code: string): RemittanceClaim | undefined {
    return this.list().find((c) => c.code.toUpperCase() === code.toUpperCase());
  }
  list(): RemittanceClaim[] { return [...this.byId.values()]; }
  sentBy(customerId: string): RemittanceClaim[] { return this.list().filter((c) => c.senderCustomerId === customerId); }
  reservedFor(country: string, msisdn: string): RemittanceClaim[] {
    return this.list().filter((c) => c.status === 'reserved' && c.destCountry === country.toUpperCase() && c.destMsisdn === msisdn);
  }

  private flush(c: RemittanceClaim): void {
    if (!this.sink) return;
    this.sink.persist({ ...c }).catch((e) => console.error('[remit] persist failed:', e && e.message ? e.message : e));
  }
}
