/**
 * The single most important seam in the rail. Every mobile-money operator
 * (MTN MoMo per operating company, Safaricom Daraja, others) is reached through
 * this one interface. Adding a market is implementing/parameterising an adapter,
 * never branching the business logic.
 */

export type ProviderTxStatus = 'pending' | 'success' | 'failed';

export interface CollectRequest {
  msisdn: string;       // canonical bare MSISDN, e.g. "256772123456"
  amount: string;       // major-unit decimal in the market's local currency
  currency: string;
  reference: string;    // our idempotency reference
  payerNote?: string;
}

export interface DisburseRequest {
  msisdn: string;
  amount: string;
  currency: string;
  reference: string;
  payeeNote?: string;
}

export interface ProviderResult {
  providerRef: string;              // the operator's own transaction handle
  status: ProviderTxStatus;
  failureReason?: string;
  raw?: unknown;
}

export interface NormalizedCallback {
  reference: string;
  providerRef: string;
  status: ProviderTxStatus;
  failureReason?: string;
}

export interface MobileMoneyProvider {
  readonly key: string;
  /** Pull funds IN from a subscriber (MoMo Collections / requestToPay; Daraja STK push). */
  collect(req: CollectRequest): Promise<ProviderResult>;
  /** Push funds OUT to a subscriber (MoMo Disbursements / transfer; Daraja B2C). */
  disburse(req: DisburseRequest): Promise<ProviderResult>;
  /** Poll a transaction's status by our reference. */
  status(reference: string): Promise<ProviderResult>;
  /** Normalise an inbound webhook/callback payload to a provider-agnostic event. */
  handleCallback(payload: unknown): NormalizedCallback;
}
