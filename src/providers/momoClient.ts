import {
  CollectRequest, DisburseRequest, MobileMoneyProvider, NormalizedCallback, ProviderResult, ProviderTxStatus,
} from './mobileMoneyProvider';

/**
 * Real MTN MoMo Open API adapter — SKELETON. Compiles and maps our rail verbs
 * onto the actual Open API products, but is not exercised in tests (no live
 * operating-company credentials). One instance is parameterised per MTN OpCo
 * (Uganda, Ghana, Rwanda, …): the API spec is common across markets, only the
 * subscription key / API user / target environment differ.
 *
 *   collect  -> Collections    POST /collection/v1_0/requesttopay
 *   disburse -> Disbursements  POST /disbursement/v1_0/transfer
 *   status   -> GET .../{X-Reference-Id}
 *
 * Production hardening still to add: token caching, retry/backoff, signature
 * verification on callbacks, and per-OpCo rate limits.
 */
export interface MoMoConfig {
  baseUrl: string;            // e.g. https://sandbox.momodeveloper.mtn.com
  subscriptionKey: string;    // Ocp-Apim-Subscription-Key (per product)
  disbursementSubscriptionKey?: string;
  apiUser: string;
  apiKey: string;
  targetEnvironment: string;  // "sandbox" or the production env name
  callbackUrl?: string;
}

const httpFetch: (url: string, init?: unknown) => Promise<any> = (globalThis as any).fetch;

export class MoMoClient implements MobileMoneyProvider {
  readonly key: string;
  constructor(private readonly operator: string, private readonly cfg: MoMoConfig) {
    this.key = `momo:${operator}`;
  }

  private async token(product: 'collection' | 'disbursement'): Promise<string> {
    const subKey = product === 'disbursement' && this.cfg.disbursementSubscriptionKey
      ? this.cfg.disbursementSubscriptionKey : this.cfg.subscriptionKey;
    const basic = Buffer.from(`${this.cfg.apiUser}:${this.cfg.apiKey}`).toString('base64');
    const res = await httpFetch(`${this.cfg.baseUrl}/${product}/token/`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': subKey, Authorization: `Basic ${basic}` },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`MoMo token failed (${res.status}): ${JSON.stringify(body)}`);
    return body.access_token as string;
  }

  async collect(req: CollectRequest): Promise<ProviderResult> {
    const token = await this.token('collection');
    const res = await httpFetch(`${this.cfg.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': req.reference,
        'X-Target-Environment': this.cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: req.amount,
        currency: req.currency,
        externalId: req.reference,
        payer: { partyIdType: 'MSISDN', partyId: req.msisdn },
        payerMessage: req.payerNote ?? 'Wallet top-up',
        payeeNote: 'MoMo rail collection',
      }),
    });
    // 202 Accepted = prompt sent; final state arrives via callback or status poll.
    if (res.status === 202) return { providerRef: req.reference, status: 'pending' };
    const body = await safeJson(res);
    return { providerRef: req.reference, status: 'failed', failureReason: `requesttopay ${res.status}`, raw: body };
  }

  async disburse(req: DisburseRequest): Promise<ProviderResult> {
    const token = await this.token('disbursement');
    const res = await httpFetch(`${this.cfg.baseUrl}/disbursement/v1_0/transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': req.reference,
        'X-Target-Environment': this.cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': this.cfg.disbursementSubscriptionKey ?? this.cfg.subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: req.amount,
        currency: req.currency,
        externalId: req.reference,
        payee: { partyIdType: 'MSISDN', partyId: req.msisdn },
        payerMessage: req.payeeNote ?? 'Payout',
        payeeNote: 'MoMo rail disbursement',
      }),
    });
    if (res.status === 202) return { providerRef: req.reference, status: 'pending' };
    const body = await safeJson(res);
    return { providerRef: req.reference, status: 'failed', failureReason: `transfer ${res.status}`, raw: body };
  }

  async status(reference: string): Promise<ProviderResult> {
    const token = await this.token('collection');
    const res = await httpFetch(`${this.cfg.baseUrl}/collection/v1_0/requesttopay/${reference}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': this.cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
      },
    });
    const body = await safeJson(res);
    const map: Record<string, ProviderTxStatus> = { SUCCESSFUL: 'success', FAILED: 'failed', PENDING: 'pending' };
    return { providerRef: reference, status: map[String((body as any)?.status)] ?? 'pending', raw: body };
  }

  handleCallback(payload: unknown): NormalizedCallback {
    const p = (payload ?? {}) as Record<string, unknown>;
    const map: Record<string, ProviderTxStatus> = { SUCCESSFUL: 'success', FAILED: 'failed', PENDING: 'pending' };
    return {
      reference: String(p.externalId ?? p.referenceId ?? ''),
      providerRef: String(p.referenceId ?? ''),
      status: map[String(p.status)] ?? 'pending',
      failureReason: p.reason ? String(p.reason) : undefined,
    };
  }
}

async function safeJson(res: any): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}
