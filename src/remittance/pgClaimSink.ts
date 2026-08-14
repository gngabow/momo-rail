import { RemittanceClaim, ClaimSink } from './claimStore';

/** Postgres write-through sink for remittance claims (durable reservations). */
export class PgClaimSink implements ClaimSink {
  private pool: any;
  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    const { Pool } = require('pg');
    const ssl = /[?&]sslmode=require/.test(this.connectionString) || process.env.PGSSL === 'require'
      ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: this.connectionString, ssl, max: 3 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS remittance_claims (
      id                 text PRIMARY KEY,
      code               text NOT NULL,
      sender_customer_id text NOT NULL,
      dest_country       text NOT NULL,
      dest_msisdn        text NOT NULL,
      amount_usdt        text NOT NULL,
      status             text NOT NULL,
      created_at         bigint NOT NULL,
      claimed_at         bigint NULL,
      delivered_local    text NULL,
      delivered_currency text NULL
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_claims_dest ON remittance_claims (dest_country, dest_msisdn, status)`);
  }

  async persist(c: RemittanceClaim): Promise<void> {
    await this.pool.query(
      `INSERT INTO remittance_claims
        (id, code, sender_customer_id, dest_country, dest_msisdn, amount_usdt, status, created_at, claimed_at, delivered_local, delivered_currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET status=$7, claimed_at=$9, delivered_local=$10, delivered_currency=$11`,
      [c.id, c.code, c.senderCustomerId, c.destCountry, c.destMsisdn, c.amountUsdt, c.status,
       c.createdAt, c.claimedAt ?? null, c.deliveredLocal ?? null, c.deliveredCurrency ?? null]);
  }

  async loadOpen(): Promise<RemittanceClaim[]> {
    const r = await this.pool.query(`SELECT * FROM remittance_claims WHERE status='reserved'`);
    return r.rows.map((x: any) => ({
      id: x.id, code: x.code, senderCustomerId: x.sender_customer_id,
      destCountry: x.dest_country, destMsisdn: x.dest_msisdn, amountUsdt: x.amount_usdt,
      status: x.status, createdAt: Number(x.created_at),
      claimedAt: x.claimed_at != null ? Number(x.claimed_at) : undefined,
      deliveredLocal: x.delivered_local ?? undefined, deliveredCurrency: x.delivered_currency ?? undefined,
    }));
  }
}
