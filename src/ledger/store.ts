import { Account, JournalEntry, JournalLine } from './ledger';

/**
 * The storage seam. Both the in-memory `Ledger` and the Postgres-backed
 * `PgLedger` implement this async interface, so every service above the ledger
 * is written once and runs unchanged against either. No DATABASE_URL -> in-memory
 * (the dependency-free demo); DATABASE_URL set -> Postgres durability.
 *
 * Async throughout because a real database is async; the in-memory impl just
 * returns already-resolved promises.
 */
export interface LedgerStore {
  createAccount(params: {
    customerId?: string | null;
    currency: string;
    accountType: Account['accountType'];
    countryCode?: string | null;
    id?: string;
  }): Promise<Account>;

  getAccount(id: string): Promise<Account>;
  findCustomerWallet(customerId: string, currency: string): Promise<Account | undefined>;
  getBalance(accountId: string): Promise<{ currency: string; balance: string; minor: bigint }>;
  assertSufficientBalance(accountId: string, amount: string): Promise<void>;
  postEntry(params: { entryType: string; idempotencyKey?: string; lines: JournalLine[] }): Promise<JournalEntry>;
  listEntries(): Promise<JournalEntry[]>;

  /** Optional lifecycle — PgLedger runs migrations / opens the pool; in-memory is a no-op. */
  init?(): Promise<void>;
  close?(): Promise<void>;
}
