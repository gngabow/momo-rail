import crypto from 'crypto';
import { CountryRegistry } from '../config/countryProfile';
import { toMsisdn } from '../context/phone';

/**
 * Auth for the rail: customer sign-in by phone + OTP, and admin sign-in for the
 * ops console. Sessions are bearer tokens.
 *
 * The customer identity is derived from (country, MSISDN) so a wallet is tied to
 * a phone number rather than an anonymous browser id. OTP delivery is pluggable:
 * with no SMS provider wired (the demo), the code is returned in the response
 * and logged so the flow can be completed; in production it is sent over SMS and
 * never returned.
 *
 * Sessions are in-memory (a restart signs everyone out — acceptable now; a
 * `sessions` table is a later hardening). Admin credentials come from env
 * (ADMIN_USERNAME / ADMIN_PASSWORD) so a password is never in code.
 */
export type SessionKind = 'customer' | 'admin';
export interface Session { token: string; subject: string; kind: SessionKind; createdAt: number; expiresAt: number; }

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function customerIdFor(country: string, msisdn: string): string {
  return `cust:${country.toUpperCase()}:${msisdn}`;
}

export class AuthService {
  private otps = new Map<string, { code: string; expiresAt: number; attempts: number }>();
  private sessions = new Map<string, Session>();

  constructor(private readonly registry: CountryRegistry) {}

  private otpKey(country: string, msisdn: string): string { return `${country.toUpperCase()}:${msisdn}`; }

  /** Step 1: request an OTP for a phone number. */
  requestOtp(country: string, national: string): { sent: true; to: string; expiresInSec: number; devCode?: string } {
    const profile = this.registry.require(country);
    const msisdn = toMsisdn(profile, national);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.otps.set(this.otpKey(country, msisdn), { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    const devReturn = !process.env.SMS_PROVIDER; // no SMS wired -> expose for the demo
    if (devReturn) console.log(`[auth] OTP for +${msisdn}: ${code} (dev — no SMS provider)`);
    return { sent: true, to: `+${msisdn}`, expiresInSec: OTP_TTL_MS / 1000, devCode: devReturn ? code : undefined };
  }

  /** Step 2: verify the OTP; on success issue a customer session. */
  verifyOtp(country: string, national: string, code: string): { token: string; customerId: string; msisdn: string } {
    const profile = this.registry.require(country);
    const msisdn = toMsisdn(profile, national);
    const key = this.otpKey(country, msisdn);
    const rec = this.otps.get(key);
    if (!rec) throw new AuthError('No OTP requested for this number');
    if (Date.now() > rec.expiresAt) { this.otps.delete(key); throw new AuthError('OTP expired — request a new one'); }
    rec.attempts++;
    if (rec.attempts > OTP_MAX_ATTEMPTS) { this.otps.delete(key); throw new AuthError('Too many attempts — request a new OTP'); }
    if (!timingSafeEqualStr(String(code), rec.code)) throw new AuthError('Incorrect code');

    this.otps.delete(key);
    const customerId = customerIdFor(country, msisdn);
    const token = this.issue(customerId, 'customer');
    return { token, customerId, msisdn };
  }

  /** Admin sign-in against env credentials. */
  adminLogin(username: string, password: string): { token: string } {
    const U = process.env.ADMIN_USERNAME || 'admin';
    const P = process.env.ADMIN_PASSWORD;
    if (!P) throw new AuthError('Admin is not configured (set ADMIN_PASSWORD)');
    const okU = timingSafeEqualStr(username, U);
    const okP = timingSafeEqualStr(password, P);
    if (!okU || !okP) throw new AuthError('Invalid admin credentials');
    return { token: this.issue(username, 'admin') };
  }

  private issue(subject: string, kind: SessionKind): string {
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    this.sessions.set(token, { token, subject, kind, createdAt: now, expiresAt: now + SESSION_TTL_MS });
    return token;
  }

  /** Resolve a bearer token to a live session (or undefined). */
  resolve(token: string | undefined | null): Session | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (Date.now() > s.expiresAt) { this.sessions.delete(token); return undefined; }
    return s;
  }

  logout(token: string | undefined | null): void { if (token) this.sessions.delete(token); }
}

export class AuthError extends Error {}

/** Constant-time string compare (hash-normalised so lengths don't leak). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
