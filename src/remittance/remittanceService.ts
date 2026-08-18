import crypto from 'crypto';
import { newId } from '../util/id';
import { CountryRegistry } from '../config/countryProfile';
import { LedgerStore } from '../ledger/store';
import { FxRateProvider } from '../fx/fxRateProvider';
import { provisionWallet } from '../wallet/walletService';
import { toMsisdn } from '../context/phone';
import { customerIdFor } from '../auth/authService';
import { toMinor, fromMinor, roundTo } from '../ledger/money';
import { ClaimStore, RemittanceClaim } from './claimStore';

const REMIT_ESCROW = 'sys-USDT-remit-escrow';
const USDT_FEEREV = 'sys-USDT-feerev';
const OUTBOUND_INTL_FEE_RATE_DEFAULT = 0.01; // used when the sender isn't an Opco customer
const REMIT_REVIEW_USDT = Number(process.env.REMIT_REVIEW_USDT || 1000); // large-value review flag (USDT)

export class RemittanceError extends Error {}

export interface DeliveryQuote {
  currency: string; rateLocalPerUsdt: string; gross: string; fee: string; feeRate: number; net: string;
}

/**
 * Cross-border remittance on the stablecoin rail with an invite/claim flow.
 * The sender's USDT is reserved into escrow immediately; the recipient (a phone
 * number that need not be registered yet) claims it, at which point it's
 * converted to their local currency at the destination market's rate and the
 * remittance fee, and credited to their wallet. Delivery also happens
 * automatically when that phone number signs in (see auto-claim on OTP verify).
 */
export class RemittanceService {
  constructor(
    private readonly ledger: LedgerStore,
    private readonly registry: CountryRegistry,
    private readonly fx: FxRateProvider,
    private readonly claims: ClaimStore,
  ) {}

  private shortCode(): string { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

  /** Cross-border screening: block on a sanctions match, flag large values for review.
   *  Runs before any funds are reserved. Real sanctions/AML vendors sit behind the
   *  same seam as the mobile-money provider. */
  private screenCrossBorder(amountUsdt: string, sanctionsHit?: boolean): { decision: 'pass' | 'review' | 'block'; reason?: string } {
    if (sanctionsHit) return { decision: 'block', reason: 'Sanctions screening match' };
    if (Number(amountUsdt) >= REMIT_REVIEW_USDT) return { decision: 'review', reason: `Above cross-border review threshold (${REMIT_REVIEW_USDT} USDT)` };
    return { decision: 'pass' };
  }

  /** What the recipient would receive for a given USDT amount in a destination market. */
  async quoteDelivery(destCountry: string, amountUsdt: string): Promise<DeliveryQuote> {
    const dest = this.registry.require(destCountry);
    const local = dest.localCurrency;
    const rate = await this.fx.getLocalPerUsdt(local);
    const R = Number(rate);
    const feeRate = dest.feeSchedule.remittanceRate;
    const Uminor = toMinor(roundTo(Number(amountUsdt), 'USDT'), 'USDT');
    const grossNum = Number(fromMinor(Uminor, 'USDT')) * R;
    const grossMinor = toMinor(roundTo(grossNum, local), local);
    const feeMinor = toMinor(roundTo(grossNum * feeRate, local), local);
    const netMinor = grossMinor - feeMinor;
    return {
      currency: local, rateLocalPerUsdt: rate,
      gross: fromMinor(grossMinor, local), fee: fromMinor(feeMinor, local),
      feeRate, net: fromMinor(netMinor, local),
    };
  }

  private normaliseMsisdn(raw: string): string {
    return String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  }

  /** Outbound fee rate: the sender's Opco market's remittance rate, else a default. */
  private outboundFeeRate(senderCustomerId: string): number {
    const m = /^cust:([A-Z]{2}):/.exec(senderCustomerId);
    if (m) { try { return this.registry.get(m[1]).feeSchedule.remittanceRate; } catch { /* not a market */ } }
    return OUTBOUND_INTL_FEE_RATE_DEFAULT;
  }

  /** USDT-out delivery: the recipient receives USDT (no local conversion), less an outbound fee. */
  quoteOutboundUsdt(amountUsdt: string, feeRate: number): DeliveryQuote {
    const Uminor = toMinor(roundTo(Number(amountUsdt), 'USDT'), 'USDT');
    const feeMinor = toMinor(roundTo(Number(fromMinor(Uminor, 'USDT')) * feeRate, 'USDT'), 'USDT');
    const netMinor = Uminor - feeMinor;
    return {
      currency: 'USDT', rateLocalPerUsdt: '1',
      gross: fromMinor(Uminor, 'USDT'), fee: fromMinor(feeMinor, 'USDT'),
      feeRate, net: fromMinor(netMinor, 'USDT'),
    };
  }

  /** Outbound remittance to a non-Opco (international) recipient, delivered in USDT.
   * Covers C2C (a person's USDT account) and C2B (a business's USDT wallet) — the
   * money movement is identical; recipientType only labels it. Gated on the sender
   * market's `outboundRemittance` feature when the sender is an Opco customer. */
  async sendIntl(p: { senderCustomerId: string; destMsisdn: string; amountUsdt: string; recipientType?: 'person' | 'business'; destLabel?: string; sanctionsHit?: boolean }): Promise<{ claim: RemittanceClaim; estimate: DeliveryQuote }> {
    const screen = this.screenCrossBorder(p.amountUsdt, p.sanctionsHit);
    if (screen.decision === 'block') throw new RemittanceError(`Transfer blocked: ${screen.reason}`);
    const sm = /^cust:([A-Z]{2}):/.exec(p.senderCustomerId);
    if (sm) { try { const prof = this.registry.get(sm[1]); if (!prof.features.outboundRemittance) throw new RemittanceError(`Outbound remittance is not enabled for ${prof.code}`); } catch (e) { if (e instanceof RemittanceError) throw e; } }
    const msisdn = this.normaliseMsisdn(p.destMsisdn);
    if (!msisdn) throw new RemittanceError('A destination number is required');
    const senderUsdt = await provisionWallet(this.ledger, p.senderCustomerId, 'USDT', null);
    await this.ledger.assertSufficientBalance(senderUsdt.id, p.amountUsdt);
    const id = newId();

    await this.ledger.postEntry({
      entryType: 'remit_reserve',
      idempotencyKey: `remit-res-${id}`,
      lines: [
        { accountId: senderUsdt.id, amount: `-${p.amountUsdt}` },
        { accountId: REMIT_ESCROW, amount: p.amountUsdt },
      ],
    });

    const claim = this.claims.add({
      id, code: this.shortCode(), senderCustomerId: p.senderCustomerId,
      destCountry: 'INTL', destMsisdn: msisdn, amountUsdt: p.amountUsdt,
      status: 'reserved', createdAt: Date.now(),
      recipientType: p.recipientType || 'person', destLabel: p.destLabel,
      screen: screen.decision === 'review' ? 'review' : 'pass', screenReason: screen.reason,
    });
    return { claim, estimate: this.quoteOutboundUsdt(p.amountUsdt, this.outboundFeeRate(p.senderCustomerId)) };
  }

  /** Reserve funds for a recipient phone number. */
  async send(p: { senderCustomerId: string; destCountry: string; destNational: string; amountUsdt: string; sanctionsHit?: boolean }): Promise<{ claim: RemittanceClaim; estimate: DeliveryQuote }> {
    const dest = this.registry.require(p.destCountry);
    if (!dest.features.inboundRemittance) throw new RemittanceError(`Inbound remittance is not enabled for ${p.destCountry}`);
    const screen = this.screenCrossBorder(p.amountUsdt, p.sanctionsHit);
    if (screen.decision === 'block') throw new RemittanceError(`Transfer blocked: ${screen.reason}`);
    const senderUsdt = await provisionWallet(this.ledger, p.senderCustomerId, 'USDT', null);
    await this.ledger.assertSufficientBalance(senderUsdt.id, p.amountUsdt);
    const destMsisdn = toMsisdn(dest, p.destNational);
    const id = newId();

    await this.ledger.postEntry({
      entryType: 'remit_reserve',
      idempotencyKey: `remit-res-${id}`,
      lines: [
        { accountId: senderUsdt.id, amount: `-${p.amountUsdt}` },
        { accountId: REMIT_ESCROW, amount: p.amountUsdt },
      ],
    });

    const claim = this.claims.add({
      id, code: this.shortCode(), senderCustomerId: p.senderCustomerId,
      destCountry: dest.code, destMsisdn, amountUsdt: p.amountUsdt,
      status: 'reserved', createdAt: Date.now(),
      screen: screen.decision === 'review' ? 'review' : 'pass', screenReason: screen.reason,
    });
    return { claim, estimate: await this.quoteDelivery(dest.code, p.amountUsdt) };
  }

  /** Deliver an outbound-international claim in USDT (no local conversion). */
  private async deliverIntl(c: RemittanceClaim, recipientCustomerId?: string): Promise<{ claim: RemittanceClaim; delivered: { amount: string; currency: string } }> {
    const rcid = recipientCustomerId || customerIdFor('INTL', c.destMsisdn);
    const wallet = await provisionWallet(this.ledger, rcid, 'USDT', null);
    const q = this.quoteOutboundUsdt(c.amountUsdt, this.outboundFeeRate(c.senderCustomerId));
    const lines = [
      { accountId: REMIT_ESCROW, amount: `-${c.amountUsdt}` },
      { accountId: wallet.id, amount: q.net },
    ];
    if (Number(q.fee) > 0) lines.push({ accountId: USDT_FEEREV, amount: q.fee });
    await this.ledger.postEntry({ entryType: 'remit_deliver', idempotencyKey: `remit-del-${c.id}`, lines });
    c.status = 'claimed'; c.claimedAt = Date.now();
    c.deliveredLocal = q.net; c.deliveredCurrency = 'USDT';
    this.claims.update(c);
    return { claim: c, delivered: { amount: q.net, currency: 'USDT' } };
  }

  /** Deliver a single reserved claim to the recipient's wallet. */
  private async deliver(c: RemittanceClaim, recipientCustomerId?: string): Promise<{ claim: RemittanceClaim; delivered: { amount: string; currency: string } }> {
    if (c.destCountry === 'INTL') return this.deliverIntl(c, recipientCustomerId);
    const dest = this.registry.require(c.destCountry);
    const rcid = recipientCustomerId || customerIdFor(c.destCountry, c.destMsisdn);
    const wallet = await provisionWallet(this.ledger, rcid, dest.localCurrency, dest.code);
    const q = await this.quoteDelivery(dest.code, c.amountUsdt);

    await this.ledger.postEntry({
      entryType: 'remit_deliver',
      idempotencyKey: `remit-del-${c.id}`,
      lines: [
        { accountId: REMIT_ESCROW, amount: `-${c.amountUsdt}` },
        { accountId: dest.ledgerAccounts.usdtHotWalletId, amount: c.amountUsdt },
        { accountId: dest.ledgerAccounts.localFloatId, amount: `-${q.gross}` },
        { accountId: wallet.id, amount: q.net },
        { accountId: dest.ledgerAccounts.localFeeRevenueId, amount: q.fee },
      ],
    });

    c.status = 'claimed'; c.claimedAt = Date.now();
    c.deliveredLocal = q.net; c.deliveredCurrency = dest.localCurrency;
    this.claims.update(c);
    return { claim: c, delivered: { amount: q.net, currency: dest.localCurrency } };
  }

  /** Claim one reservation by id or code. */
  async claim(idOrCode: string, recipientCustomerId?: string) {
    const c = this.claims.get(idOrCode) || this.claims.getByCode(idOrCode);
    if (!c) throw new RemittanceError('No such claim');
    if (c.status !== 'reserved') throw new RemittanceError(`Claim already ${c.status}`);
    // Bind explicit claims to the verified recipient number: the session subject
    // must be the canonical id for the number this transfer was reserved for.
    if (recipientCustomerId) {
      const expected = customerIdFor(c.destCountry, c.destMsisdn);
      if (recipientCustomerId !== expected) {
        throw new RemittanceError('This transfer was sent to a different number. Sign in with the number it was sent to and it will be delivered automatically.');
      }
    }
    return this.deliver(c, recipientCustomerId);
  }

  /** Deliver every reservation for a phone number (used on signup/sign-in). */
  async claimAllFor(country: string, msisdn: string, recipientCustomerId?: string) {
    const list = this.claims.reservedFor(country, msisdn);
    const out = [];
    for (const c of list) out.push(await this.deliver(c, recipientCustomerId));
    return out;
  }

  /** Refund a still-reserved claim to the sender (ops/TTL action): reverses escrow -> sender. */
  async refund(idOrCode: string): Promise<RemittanceClaim> {
    const c = this.claims.get(idOrCode) || this.claims.getByCode(idOrCode);
    if (!c) throw new RemittanceError('No such claim');
    if (c.status !== 'reserved') throw new RemittanceError(`Claim already ${c.status}`);
    const senderUsdt = await provisionWallet(this.ledger, c.senderCustomerId, 'USDT', null);
    await this.ledger.postEntry({
      entryType: 'remit_refund',
      idempotencyKey: `remit-ref-${c.id}`,
      lines: [
        { accountId: REMIT_ESCROW, amount: `-${c.amountUsdt}` },
        { accountId: senderUsdt.id, amount: c.amountUsdt },
      ],
    });
    c.status = 'refunded'; c.refundedAt = Date.now();
    this.claims.update(c);
    return c;
  }

  /** Reserved claims at least ttlMs old — candidates for auto-refund. */
  staleReserved(ttlMs: number, now: number): RemittanceClaim[] {
    return this.reservedClaims().filter((c) => now - c.createdAt >= ttlMs);
  }

  outboxFor(customerId: string): RemittanceClaim[] { return this.claims.sentBy(customerId); }
  inboxFor(country: string, msisdn: string): RemittanceClaim[] { return this.claims.reservedFor(country, msisdn); }
  /** All still-reserved claims across the system (ops view). */
  reservedClaims(): RemittanceClaim[] { return this.claims.list().filter((c) => c.status === 'reserved'); }
}
