import { PendingSettlement, PendingSink } from './settlement';

/**
 * Postgres write-through sink for pending settlements. Keeps in-flight MoMo
 * intents durable so a restart mid-flight can still settle a late callback.
 * `pg` is lazily required (same pattern as PgLedger / PgOverrideStore).
 */
export class PgPendingSink implements PendingSink {
  private pool: any;
  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    const { Pool } = require('pg');
    const ssl = /[?&]sslmode=require/.test(this.connectionString) || process.env.PGSSL === 'require'
      ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: this.connectionString, ssl, max: 3 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS pending_settlements (
      reference    text PRIMARY KEY,
      kind         text NOT NULL,
      country_code text NOT NULL,
      customer_id  text NOT NULL,
      currency     text NOT NULL,
      amount_local text NOT NULL,
      wallet_id    text NOT NULL,
      float_id     text NOT NULL,
      suspense_id  text NULL,
      status       text NOT NULL,
      provider_ref text NULL,
      reason       text NULL,
      created_at   bigint NOT NULL,
      settled_at   bigint NULL
    )`);
  }

  async persist(i: PendingSettlement): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_settlements
        (reference, kind, country_code, customer_id, currency, amount_local, wallet_id, float_id, suspense_id, status, provider_ref, reason, created_at, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (reference) DO UPDATE SET
         status=$10, provider_ref=$11, reason=$12, settled_at=$14`,
      [i.reference, i.kind, i.countryCode, i.customerId, i.currency, i.amountLocal, i.walletId, i.floatId,
       i.suspenseId ?? null, i.status, i.providerRef ?? null, i.reason ?? null, i.createdAt, i.settledAt ?? null]);
  }

  async loadOpen(): Promise<PendingSettlement[]> {
    const r = await this.pool.query(`SELECT * FROM pending_settlements WHERE status='pending'`);
    return r.rows.map((x: any) => ({
      reference: x.reference, kind: x.kind, countryCode: x.country_code, customerId: x.customer_id,
      currency: x.currency, amountLocal: x.amount_local, walletId: x.wallet_id, floatId: x.float_id,
      suspenseId: x.suspense_id ?? undefined, status: x.status,
      providerRef: x.provider_ref ?? undefined, reason: x.reason ?? undefined,
      createdAt: Number(x.created_at), settledAt: x.settled_at != null ? Number(x.settled_at) : undefined,
    }));
  }
}
