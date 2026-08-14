/**
 * Pending-settlement store. A real MoMo collect/disburse returns 202 (accepted,
 * not final): the money only moves on the ledger when MTN confirms SUCCESSFUL
 * via callback or a status poll. This records the intent so the terminal event
 * can settle it exactly once.
 *
 * In-memory for now (mirrors the rest of the scaffold); Phase 2 moves it to the
 * same Postgres store as the ledger so a restart doesn't lose in-flight items.
 */
export type PendingKind = 'deposit' | 'withdraw';
export type PendingStatus = 'pending' | 'success' | 'failed';

export interface PendingSettlement {
  reference: string;
  kind: PendingKind;
  countryCode: string;
  customerId: string;
  currency: string;
  amountLocal: string;
  walletId: string;
  floatId: string;
  suspenseId?: string;   // withdraw parks funds here until the disbursement confirms
  status: PendingStatus;
  createdAt: number;
  settledAt?: number;
  providerRef?: string;
  reason?: string;
}

/**
 * Optional durable sink. The in-memory map stays authoritative at runtime (so
 * reads remain synchronous with no churn on the rail's hot path); the sink is
 * written through best-effort and hydrated on boot. Postgres implementation:
 * src/rail/pgPending.ts.
 */
export interface PendingSink {
  persist(item: PendingSettlement): Promise<void>;   // upsert by reference
  loadOpen(): Promise<PendingSettlement[]>;           // still-pending items, for boot hydration
  init?(): Promise<void>;
}

export class PendingSettlements {
  private byRef = new Map<string, PendingSettlement>();

  constructor(private readonly sink?: PendingSink) {}

  /** Load still-open items from the durable sink (call once on boot). */
  async hydrate(): Promise<number> {
    if (!this.sink) return 0;
    const open = await this.sink.loadOpen();
    for (const it of open) this.byRef.set(it.reference, it);
    return open.length;
  }

  record(p: Omit<PendingSettlement, 'status' | 'createdAt'>, now: number): PendingSettlement {
    const item: PendingSettlement = { ...p, status: 'pending', createdAt: now };
    this.byRef.set(p.reference, item);
    this.flush(item);
    return item;
  }

  get(reference: string): PendingSettlement | undefined {
    return this.byRef.get(reference);
  }

  markSettled(reference: string, status: 'success' | 'failed', now: number, providerRef?: string, reason?: string): PendingSettlement | undefined {
    const item = this.byRef.get(reference);
    if (!item) return undefined;
    item.status = status;
    item.settledAt = now;
    if (providerRef) item.providerRef = providerRef;
    if (reason) item.reason = reason;
    this.flush(item);
    return item;
  }

  list(): PendingSettlement[] {
    return [...this.byRef.values()];
  }

  /** Best-effort write-through; a sink failure never breaks the in-memory path. */
  private flush(item: PendingSettlement): void {
    if (!this.sink) return;
    this.sink.persist({ ...item }).catch((e) => console.error('[pending] persist failed:', e && e.message ? e.message : e));
  }
}
