import { PaymentRequest, RequestSink } from './requestService';

/** Postgres write-through sink for payment requests (durable P2P requests). */
export class PgRequestSink implements RequestSink {
  private pool: any;
  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    const { Pool } = require('pg');
    const ssl = /[?&]sslmode=require/.test(this.connectionString) || process.env.PGSSL === 'require'
      ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: this.connectionString, ssl, max: 3 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS payment_requests (
      id                     text PRIMARY KEY,
      code                   text NOT NULL,
      requester_customer_id  text NOT NULL,
      currency               text NOT NULL,
      country                text NULL,
      amount                 text NOT NULL,
      note                   text NOT NULL DEFAULT '',
      status                 text NOT NULL,
      created_at             bigint NOT NULL,
      paid_at                bigint NULL,
      payer_customer_id      text NULL
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_requests_requester ON payment_requests (requester_customer_id, status)`);
  }

  async persist(r: PaymentRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_requests
        (id, code, requester_customer_id, currency, country, amount, note, status, created_at, paid_at, payer_customer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET status=$8, paid_at=$10, payer_customer_id=$11`,
      [r.id, r.code, r.requesterCustomerId, r.currency, r.country ?? null, r.amount, r.note ?? '',
       r.status, r.createdAt, r.paidAt ?? null, r.payerCustomerId ?? null]);
  }

  async loadOpen(): Promise<PaymentRequest[]> {
    const r = await this.pool.query(`SELECT * FROM payment_requests WHERE status='open'`);
    return r.rows.map((x: any) => ({
      id: x.id, code: x.code, requesterCustomerId: x.requester_customer_id,
      currency: x.currency, country: x.country ?? null, amount: x.amount, note: x.note ?? '',
      status: x.status, createdAt: Number(x.created_at),
      paidAt: x.paid_at != null ? Number(x.paid_at) : undefined,
      payerCustomerId: x.payer_customer_id ?? undefined,
    }));
  }
}
