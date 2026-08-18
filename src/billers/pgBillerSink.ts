import { Biller, BillPayReceipt, BillerSink } from './billerService';

/** Postgres write-through sink for admin-edited billers and bill-pay receipts. */
export class PgBillerSink implements BillerSink {
  private pool: any;
  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    const { Pool } = require('pg');
    const ssl = /[?&]sslmode=require/.test(this.connectionString) || process.env.PGSSL === 'require'
      ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: this.connectionString, ssl, max: 3 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS billers (
      code      text PRIMARY KEY,
      name      text NOT NULL,
      country   text NOT NULL,
      currency  text NOT NULL,
      category  text NOT NULL,
      enabled   boolean NOT NULL DEFAULT true
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS bill_receipts (
      ref          text PRIMARY KEY,
      biller_code  text NOT NULL,
      biller_name  text NOT NULL,
      amount       text NOT NULL,
      currency     text NOT NULL,
      model        text NOT NULL,
      at           bigint NOT NULL
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_receipts_at ON bill_receipts (at DESC)`);
  }

  async persistBiller(b: Biller): Promise<void> {
    await this.pool.query(
      `INSERT INTO billers (code, name, country, currency, category, enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET name=$2, country=$3, currency=$4, category=$5, enabled=$6`,
      [b.code, b.name, b.country, b.currency, b.category, b.enabled]);
  }

  async persistReceipt(r: BillPayReceipt): Promise<void> {
    await this.pool.query(
      `INSERT INTO bill_receipts (ref, biller_code, biller_name, amount, currency, model, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ref) DO NOTHING`,
      [r.ref, r.billerCode, r.billerName, r.amount, r.currency, r.model, r.at]);
  }

  async loadBillers(): Promise<Biller[]> {
    const r = await this.pool.query(`SELECT * FROM billers`);
    return r.rows.map((x: any) => ({
      code: x.code, name: x.name, country: x.country,
      currency: x.currency, category: x.category, enabled: !!x.enabled,
    }));
  }

  async loadReceipts(limit: number): Promise<BillPayReceipt[]> {
    const r = await this.pool.query(`SELECT * FROM bill_receipts ORDER BY at DESC LIMIT $1`, [limit]);
    return r.rows.map((x: any) => ({
      ref: x.ref, billerCode: x.biller_code, billerName: x.biller_name,
      amount: x.amount, currency: x.currency, model: x.model, at: Number(x.at),
    }));
  }
}
