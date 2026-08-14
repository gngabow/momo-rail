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

export class PendingSettlements {
  private byRef = new Map<string, PendingSettlement>();

  record(p: Omit<PendingSettlement, 'status' | 'createdAt'>, now: number): PendingSettlement {
    const item: PendingSettlement = { ...p, status: 'pending', createdAt: now };
    this.byRef.set(p.reference, item);
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
    return item;
  }

  list(): PendingSettlement[] {
    return [...this.byRef.values()];
  }
}
