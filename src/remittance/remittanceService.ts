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

  /** Reserve funds for a recipient phone number. */
  async send(p: { senderCustomerId: string; destCountry: string; destNational: string; amountUsdt: string }): Promise<{ claim: RemittanceClaim; estimate: DeliveryQuote }> {
    const dest = this.registry.require(p.destCountry);
    if (!dest.features.inboundRemittance) throw new RemittanceError(`Inbound remittance is not enabled for ${p.destCountry}`);
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
    });
    return { claim, estimate: await this.quoteDelivery(dest.code, p.amountUsdt) };
  }

  /** Deliver a single reserved claim to the recipient's wallet. */
  private async deliver(c: RemittanceClaim, recipientCustomerId?: string): Promise<{ claim: RemittanceClaim; delivered: { amount: string; currency: string } }> {
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
    return this.deliver(c, recipientCustomerId);
  }

  /** Deliver every reservation for a phone number (used on signup/sign-in). */
  async claimAllFor(country: string, msisdn: string, recipientCustomerId?: string) {
    const list = this.claims.reservedFor(country, msisdn);
    const out = [];
    for (const c of list) out.push(await this.deliver(c, recipientCustomerId));
    return out;
  }

  outboxFor(customerId: string): RemittanceClaim[] { return this.claims.sentBy(customerId); }
  inboxFor(country: string, msisdn: string): RemittanceClaim[] { return this.claims.reservedFor(country, msisdn); }
}
