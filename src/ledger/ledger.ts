import { newId } from '../util/id';
import { toMinor, fromMinor } from './money';

/**
 * Currency-agnostic double-entry ledger. Currency is just a field on an
 * account — the same engine holds KES, UGX, GHS, USDT side by side. Every
 * journal entry must balance to zero *per currency*. In-memory here (the
 * greenfield scaffold); a Postgres-backed implementation of the same
 * interface is the production step (see migrations/ for the schema).
 */

export type AccountType =
  | 'customer_wallet'
  | 'system_local_float'
  | 'system_fee_revenue'
  | 'system_usdt_hot_wallet'
  | 'system_suspense';

export interface Account {
  id: string;
  customerId: string | null;
  currency: string;
  accountType: AccountType;
  countryCode: string | null; // null for shared/cross-market accounts (e.g. USDT hot wallet)
  status: 'active' | 'frozen';
  createdAt: Date;
}

export interface JournalLine {
  accountId: string;
  amount: string; // major-unit decimal string, may be negative; currency inferred from the account
}

export interface JournalEntry {
  id: string;
  entryType: string;
  idempotencyKey: string | null;
  lines: { accountId: string; amount: string; currency: string }[];
  createdAt: Date;
}

export class LedgerError extends Error {}
export class AccountNotFoundError extends LedgerError {
  constructor(id: string) { super(`Account not found: ${id}`); }
}
export class UnbalancedEntryError extends LedgerError {
  constructor(currency: string, sum: string) { super(`Journal entry does not balance for ${currency} (residual ${sum})`); }
}
export class InsufficientBalanceError extends LedgerError {
  constructor(accountId: string, need: string, have: string) {
    super(`Insufficient balance in ${accountId}: need ${need}, have ${have}`);
  }
}

export class Ledger {
  private accounts = new Map<string, Account>();
  private balances = new Map<string, bigint>(); // accountId -> minor units
  private entries: JournalEntry[] = [];
  private idempotency = new Map<string, JournalEntry>();

  createAccount(params: {
    customerId?: string | null;
    currency: string;
    accountType: AccountType;
    countryCode?: string | null;
    id?: string;
  }): Account {
    const acct: Account = {
      id: params.id ?? newId(),
      customerId: params.customerId ?? null,
      currency: params.currency,
      accountType: params.accountType,
      countryCode: params.countryCode ?? null,
      status: 'active',
      createdAt: new Date(),
    };
    this.accounts.set(acct.id, acct);
    this.balances.set(acct.id, 0n);
    return acct;
  }

  getAccount(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new AccountNotFoundError(id);
    return a;
  }

  /** Find a customer's wallet for a currency (idempotent provisioning helper). */
  findCustomerWallet(customerId: string, currency: string): Account | undefined {
    for (const a of this.accounts.values()) {
      if (a.customerId === customerId && a.currency === currency && a.accountType === 'customer_wallet') return a;
    }
    return undefined;
  }

  getBalance(accountId: string): { currency: string; balance: string; minor: bigint } {
    const a = this.getAccount(accountId);
    const minor = this.balances.get(accountId) ?? 0n;
    return { currency: a.currency, balance: fromMinor(minor, a.currency), minor };
  }

  assertSufficientBalance(accountId: string, amount: string): void {
    const a = this.getAccount(accountId);
    const have = this.balances.get(accountId) ?? 0n;
    const need = toMinor(amount, a.currency);
    if (have < need) throw new InsufficientBalanceError(accountId, amount, fromMinor(have, a.currency));
  }

  /** Post a balanced multi-currency journal entry. Idempotent on idempotencyKey. */
  postEntry(params: { entryType: string; idempotencyKey?: string; lines: JournalLine[] }): JournalEntry {
    if (params.idempotencyKey) {
      const prior = this.idempotency.get(params.idempotencyKey);
      if (prior) return prior;
    }
    // Resolve each line's currency from its account and sum per currency.
    const perCurrency = new Map<string, bigint>();
    const resolved = params.lines.map((l) => {
      const acct = this.getAccount(l.accountId);
      const minor = toMinor(l.amount, acct.currency);
      perCurrency.set(acct.currency, (perCurrency.get(acct.currency) ?? 0n) + minor);
      return { accountId: l.accountId, amount: l.amount, currency: acct.currency, minor };
    });
    for (const [currency, sum] of perCurrency) {
      if (sum !== 0n) throw new UnbalancedEntryError(currency, fromMinor(sum, currency));
    }
    // Apply.
    for (const r of resolved) {
      this.balances.set(r.accountId, (this.balances.get(r.accountId) ?? 0n) + r.minor);
    }
    const entry: JournalEntry = {
      id: newId(),
      entryType: params.entryType,
      idempotencyKey: params.idempotencyKey ?? null,
      lines: resolved.map((r) => ({ accountId: r.accountId, amount: r.amount, currency: r.currency })),
      createdAt: new Date(),
    };
    this.entries.push(entry);
    if (params.idempotencyKey) this.idempotency.set(params.idempotencyKey, entry);
    return entry;
  }

  listEntries(): JournalEntry[] {
    return [...this.entries];
  }
}
