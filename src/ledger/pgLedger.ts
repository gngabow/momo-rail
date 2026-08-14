import fs from 'fs';
import path from 'path';
import { newId } from '../util/id';
import { toMinor, fromMinor } from './money';
import {
  Account, JournalEntry, JournalLine,
  AccountNotFoundError, UnbalancedEntryError, InsufficientBalanceError,
} from './ledger';
import { LedgerStore } from './store';

/**
 * Postgres-backed LedgerStore — same async interface as the in-memory `Ledger`,
 * so every service above it is unchanged. Selected when DATABASE_URL is set.
 *
 * `pg` is required lazily (only when this class is constructed) so the
 * dependency-free demo path never needs the driver installed. Balances are the
 * SUM of an account's journal lines — always exact, never a cached figure that
 * can drift. Entries are written in a transaction; idempotency is enforced by a
 * UNIQUE index on idempotency_key.
 */
export class PgLedger implements LedgerStore {
  private pool: any;
  private readonly connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  async init(): Promise<void> {
    // Lazy require so the mock/in-memory path doesn't need `pg` installed.
    const { Pool } = require('pg');
    const ssl = /[?&]sslmode=require/.test(this.connectionString) || process.env.PGSSL === 'require'
      ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: this.connectionString, ssl, max: 6 });
    await this.runMigrations();
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  private migrationsDir(): string {
    for (const d of [
      path.join(process.cwd(), 'migrations'),
      path.join(__dirname, '..', '..', 'migrations'),
      path.join(__dirname, '..', '..', '..', 'migrations'),
    ]) {
      if (fs.existsSync(d)) return d;
    }
    throw new Error('migrations directory not found');
  }

  private async runMigrations(): Promise<void> {
    const dir = this.migrationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await this.pool.query(sql);
    }
  }

  async createAccount(params: {
    customerId?: string | null;
    currency: string;
    accountType: Account['accountType'];
    countryCode?: string | null;
    id?: string;
  }): Promise<Account> {
    const id = params.id ?? newId();
    const customerId = params.customerId ?? null;
    const countryCode = params.countryCode ?? null;
    // ON CONFLICT: system accounts are (re)ensured on every boot; keep the existing row.
    await this.pool.query(
      `INSERT INTO accounts (id, customer_id, currency, account_type, country_code, status)
       VALUES ($1,$2,$3,$4,$5,'active') ON CONFLICT (id) DO NOTHING`,
      [id, customerId, params.currency, params.accountType, countryCode],
    );
    return this.getAccount(id);
  }

  async getAccount(id: string): Promise<Account> {
    const r = await this.pool.query(
      `SELECT id, customer_id, currency, account_type, country_code, status, created_at FROM accounts WHERE id=$1`, [id]);
    if (r.rowCount === 0) throw new AccountNotFoundError(id);
    return rowToAccount(r.rows[0]);
  }

  async findCustomerWallet(customerId: string, currency: string): Promise<Account | undefined> {
    const r = await this.pool.query(
      `SELECT id, customer_id, currency, account_type, country_code, status, created_at
       FROM accounts WHERE customer_id=$1 AND currency=$2 AND account_type='customer_wallet' LIMIT 1`,
      [customerId, currency]);
    return r.rowCount === 0 ? undefined : rowToAccount(r.rows[0]);
  }

  private async balanceMinor(accountId: string): Promise<bigint> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(amount_minor),0)::text AS bal FROM journal_lines WHERE account_id=$1`, [accountId]);
    return BigInt(r.rows[0].bal);
  }

  async getBalance(accountId: string): Promise<{ currency: string; balance: string; minor: bigint }> {
    const a = await this.getAccount(accountId);
    const minor = await this.balanceMinor(accountId);
    return { currency: a.currency, balance: fromMinor(minor, a.currency), minor };
  }

  async assertSufficientBalance(accountId: string, amount: string): Promise<void> {
    const a = await this.getAccount(accountId);
    const have = await this.balanceMinor(accountId);
    const need = toMinor(amount, a.currency);
    if (have < need) throw new InsufficientBalanceError(accountId, amount, fromMinor(have, a.currency));
  }

  async postEntry(params: { entryType: string; idempotencyKey?: string; lines: JournalLine[] }): Promise<JournalEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (params.idempotencyKey) {
        const prior = await client.query(`SELECT id, entry_type, idempotency_key, created_at FROM journal_entries WHERE idempotency_key=$1`, [params.idempotencyKey]);
        if (prior.rowCount > 0) {
          const entry = await this.loadEntry(client, prior.rows[0]);
          await client.query('COMMIT');
          return entry;
        }
      }

      // Resolve each line's currency from its account; sum per currency.
      const perCurrency = new Map<string, bigint>();
      const resolved: { accountId: string; amount: string; currency: string; minor: bigint }[] = [];
      for (const l of params.lines) {
        const ar = await client.query(`SELECT currency FROM accounts WHERE id=$1`, [l.accountId]);
        if (ar.rowCount === 0) throw new AccountNotFoundError(l.accountId);
        const currency = ar.rows[0].currency as string;
        const minor = toMinor(l.amount, currency);
        perCurrency.set(currency, (perCurrency.get(currency) ?? 0n) + minor);
        resolved.push({ accountId: l.accountId, amount: l.amount, currency, minor });
      }
      for (const [currency, sum] of perCurrency) {
        if (sum !== 0n) throw new UnbalancedEntryError(currency, fromMinor(sum, currency));
      }

      const entryId = newId();
      await client.query(
        `INSERT INTO journal_entries (id, entry_type, idempotency_key) VALUES ($1,$2,$3)`,
        [entryId, params.entryType, params.idempotencyKey ?? null]);
      for (const r of resolved) {
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, currency, amount_minor) VALUES ($1,$2,$3,$4)`,
          [entryId, r.accountId, r.currency, r.minor.toString()]);
      }
      await client.query('COMMIT');
      return {
        id: entryId, entryType: params.entryType, idempotencyKey: params.idempotencyKey ?? null,
        lines: resolved.map((r) => ({ accountId: r.accountId, amount: r.amount, currency: r.currency })),
        createdAt: new Date(),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async loadEntry(client: any, entryRow: any): Promise<JournalEntry> {
    const lines = await client.query(`SELECT account_id, currency, amount_minor FROM journal_lines WHERE entry_id=$1`, [entryRow.id]);
    return {
      id: entryRow.id, entryType: entryRow.entry_type, idempotencyKey: entryRow.idempotency_key,
      lines: lines.rows.map((x: any) => ({ accountId: x.account_id, amount: fromMinor(BigInt(x.amount_minor), x.currency), currency: x.currency })),
      createdAt: new Date(entryRow.created_at),
    };
  }

  async listEntries(): Promise<JournalEntry[]> {
    const er = await this.pool.query(`SELECT id, entry_type, idempotency_key, created_at FROM journal_entries ORDER BY created_at ASC`);
    const out: JournalEntry[] = [];
    for (const row of er.rows) out.push(await this.loadEntry(this.pool, row));
    return out;
  }

  async listAccounts(): Promise<Account[]> {
    const r = await this.pool.query(
      `SELECT id, customer_id, currency, account_type, country_code, status, created_at FROM accounts ORDER BY created_at ASC`);
    return r.rows.map(rowToAccount);
  }
}

function rowToAccount(r: any): Account {
  return {
    id: r.id,
    customerId: r.customer_id,
    currency: r.currency,
    accountType: r.account_type,
    countryCode: r.country_code,
    status: r.status,
    createdAt: new Date(r.created_at),
  };
}
