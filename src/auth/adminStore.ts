/**
 * DB-backed admin credentials for the momo rail. Passwords are scrypt-hashed
 * (Node built-in crypto — no new deps) and stored in admin_users. Managed by
 * scripts/seed-admin-user.ts + scripts/set-admin-password.ts.
 *
 * When DATABASE_URL is unset (the in-memory demo / tests), enabled() is false
 * and authService falls back to ADMIN_USERNAME / ADMIN_PASSWORD env creds.
 */
import crypto from 'crypto';

let _pool: any;
function getPool(): any {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { Pool } = require('pg');
  const ssl = /[?&]sslmode=require/.test(url) || process.env.PGSSL === 'require'
    ? { rejectUnauthorized: false } : undefined;
  _pool = new Pool({ connectionString: url, ssl, max: 3 });
  return _pool;
}

export function enabled(): boolean { return !!process.env.DATABASE_URL; }

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyHash(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(pw, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function verifyAdmin(username: string, password: string): Promise<{ username: string; role: string } | null> {
  const p = getPool(); if (!p) return null;
  const r = await p.query(
    `SELECT username, password_hash, role FROM admin_users WHERE username = $1 AND active = true`, [username]);
  if (!r.rows[0]) return null;
  return verifyHash(password, r.rows[0].password_hash) ? { username: r.rows[0].username, role: r.rows[0].role } : null;
}

export async function upsertAdmin(username: string, password: string, role = 'super_admin'): Promise<void> {
  const p = getPool(); if (!p) throw new Error('DATABASE_URL not set');
  await p.query(
    `INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true`,
    [username, hashPassword(password), role]);
}

export async function setPassword(username: string, password: string): Promise<boolean> {
  const p = getPool(); if (!p) throw new Error('DATABASE_URL not set');
  const r = await p.query(`UPDATE admin_users SET password_hash = $2, active = true WHERE username = $1`,
    [username, hashPassword(password)]);
  return (r.rowCount ?? 0) > 0;
}

export async function close(): Promise<void> { if (_pool) await _pool.end(); }
