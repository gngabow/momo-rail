import { MarketPatch, ProfileOverrideStore, mergePatch } from './opsService';

/**
 * Postgres-backed store for ops-console market overrides. One row per market
 * holding the accumulated patch as jsonb. Shares the pool via a lazily-required
 * `pg` (same as PgLedger) so the in-memory path never needs the driver.
 */
export class PgOverrideStore implements ProfileOverrideStore {
  private pool: any;
  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    const { Pool } = require('pg');
    const ssl = /[?&]sslmode=require/.test(this.connectionString) || process.env.PGSSL === 'require'
      ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: this.connectionString, ssl, max: 3 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS profile_overrides (
      code text PRIMARY KEY,
      patch jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async save(code: string, patch: MarketPatch): Promise<void> {
    const k = code.toUpperCase();
    const cur = await this.pool.query(`SELECT patch FROM profile_overrides WHERE code=$1`, [k]);
    const merged = mergePatch(cur.rowCount ? cur.rows[0].patch : undefined, patch);
    await this.pool.query(
      `INSERT INTO profile_overrides (code, patch, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (code) DO UPDATE SET patch=$2, updated_at=now()`,
      [k, JSON.stringify(merged)]);
  }

  async loadAll(): Promise<Record<string, MarketPatch>> {
    const r = await this.pool.query(`SELECT code, patch FROM profile_overrides`);
    const o: Record<string, MarketPatch> = {};
    for (const row of r.rows) o[row.code] = row.patch;
    return o;
  }
}
