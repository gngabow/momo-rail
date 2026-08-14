import {
  CollectRequest, DisburseRequest, MobileMoneyProvider, NormalizedCallback, ProviderResult, ProviderTxStatus,
} from './mobileMoneyProvider';

/**
 * Real MTN MoMo Open API adapter. Maps the rail's provider verbs onto the actual
 * Open API products. One instance is parameterised per MTN operating company
 * (Uganda, Ghana, Rwanda, Cameroon, …): the API spec is common across markets,
 * only the subscription key / API user / target environment differ.
 *
 *   collect  -> Collections    POST /collection/v1_0/requesttopay      (202 = prompt sent)
 *   disburse -> Disbursements  POST /disbursement/v1_0/transfer        (202 = queued)
 *   status   -> GET .../{X-Reference-Id}   (SUCCESSFUL | FAILED | PENDING)
 *   balance  -> GET /{product}/v1_0/account/balance
 *
 * A 202 means "accepted, not yet final" — the terminal state arrives via the
 * provider callback (see the /api/momo/callback/* endpoints) or a status poll.
 * The rail credits/settles the ledger only on a confirmed SUCCESSFUL.
 *
 * Hardening included: per-product OAuth token caching (honours `expires_in`),
 * bounded retry with backoff on transient network/5xx errors, and callback
 * normalisation. Still to add for production: callback signature verification
 * and per-OpCo rate limiting.
 */
export interface MoMoConfig {
  baseUrl: string;            // e.g. https://sandbox.momodeveloper.mtn.com
  collectionSubscriptionKey: string;      // Ocp-Apim-Subscription-Key for Collections
  disbursementSubscriptionKey?: string;   // ditto for Disbursements (falls back to collection key)
  apiUser: string;            // provisioned API user (UUID)
  apiKey: string;             // provisioned API key
  targetEnvironment: string;  // "sandbox" or the production env name (e.g. "mtnuganda")
  callbackUrl?: string;       // where MTN posts the terminal callback
}

type Product = 'collection' | 'disbursement';

const httpFetch: (url: string, init?: unknown) => Promise<any> = (globalThis as any).fetch;

const STATUS_MAP: Record<string, ProviderTxStatus> = { SUCCESSFUL: 'success', FAILED: 'failed', PENDING: 'pending' };

interface CachedToken { value: string; expiresAt: number; }

export class MoMoClient implements MobileMoneyProvider {
  readonly key: string;
  private tokens: Partial<Record<Product, CachedToken>> = {};

  constructor(private readonly operator: string, private readonly cfg: MoMoConfig) {
    if (!httpFetch) throw new Error('global fetch is unavailable — Node 18+ required for the MoMo adapter');
    this.key = `momo:${operator}`;
  }

  private subKey(product: Product): string {
    return product === 'disbursement' && this.cfg.disbursementSubscriptionKey
      ? this.cfg.disbursementSubscriptionKey
      : this.cfg.collectionSubscriptionKey;
  }

  /** OAuth client-credentials token, cached until ~60s before expiry. */
  private async token(product: Product): Promise<string> {
    const cached = this.tokens[product];
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value;

    const basic = Buffer.from(`${this.cfg.apiUser}:${this.cfg.apiKey}`).toString('base64');
    const res = await this.withRetry(() => httpFetch(`${this.cfg.baseUrl}/${product}/token/`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': this.subKey(product), Authorization: `Basic ${basic}` },
    }));
    const body = await safeJson(res);
    if (!res.ok) throw new Error(`MoMo ${product} token failed (${res.status}): ${JSON.stringify(body)}`);
    const ttlMs = (Number((body as any)?.expires_in) || 3600) * 1000;
    const value = String((body as any)?.access_token);
    this.tokens[product] = { value, expiresAt: Date.now() + ttlMs };
    return value;
  }

  async collect(req: CollectRequest): Promise<ProviderResult> {
    const token = await this.token('collection');
    const res = await this.withRetry(() => httpFetch(`${this.cfg.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': req.reference,
        'X-Target-Environment': this.cfg.targetEnvironment,
        ...(this.cfg.callbackUrl ? { 'X-Callback-Url': this.cfg.callbackUrl } : {}),
        'Ocp-Apim-Subscription-Key': this.subKey('collection'),
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
    }));
    // 202 Accepted = prompt sent; terminal state arrives via callback / status poll.
    if (res.status === 202) return { providerRef: req.reference, status: 'pending' };
    const body = await safeJson(res);
    return { providerRef: req.reference, status: 'failed', failureReason: `requesttopay ${res.status}`, raw: body };
  }

  async disburse(req: DisburseRequest): Promise<ProviderResult> {
    const token = await this.token('disbursement');
    const res = await this.withRetry(() => httpFetch(`${this.cfg.baseUrl}/disbursement/v1_0/transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': req.reference,
        'X-Target-Environment': this.cfg.targetEnvironment,
        ...(this.cfg.callbackUrl ? { 'X-Callback-Url': this.cfg.callbackUrl } : {}),
        'Ocp-Apim-Subscription-Key': this.subKey('disbursement'),
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
    }));
    if (res.status === 202) return { providerRef: req.reference, status: 'pending' };
    const body = await safeJson(res);
    return { providerRef: req.reference, status: 'failed', failureReason: `transfer ${res.status}`, raw: body };
  }

  async status(reference: string, product: Product = 'collection'): Promise<ProviderResult> {
    const token = await this.token(product);
    const verb = product === 'disbursement' ? 'transfer' : 'requesttopay';
    const res = await this.withRetry(() => httpFetch(`${this.cfg.baseUrl}/${product}/v1_0/${verb}/${reference}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': this.cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': this.subKey(product),
      },
    }));
    const body = await safeJson(res);
    return {
      providerRef: String((body as any)?.financialTransactionId ?? reference),
      status: STATUS_MAP[String((body as any)?.status)] ?? 'pending',
      failureReason: (body as any)?.reason ? String((body as any).reason) : undefined,
      raw: body,
    };
  }

  /** Operating-company float balance for a product account (ops/treasury view). */
  async accountBalance(product: Product = 'collection'): Promise<{ available: string; currency: string; raw: unknown }> {
    const token = await this.token(product);
    const res = await this.withRetry(() => httpFetch(`${this.cfg.baseUrl}/${product}/v1_0/account/balance`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': this.cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': this.subKey(product),
      },
    }));
    const body = await safeJson(res);
    return { available: String((body as any)?.availableBalance ?? '0'), currency: String((body as any)?.currency ?? ''), raw: body };
  }

  handleCallback(payload: unknown): NormalizedCallback {
    const p = (payload ?? {}) as Record<string, unknown>;
    return {
      reference: String(p.externalId ?? p.referenceId ?? ''),
      providerRef: String(p.financialTransactionId ?? p.referenceId ?? ''),
      status: STATUS_MAP[String(p.status)] ?? 'pending',
      failureReason: p.reason ? String(p.reason) : undefined,
    };
  }

  /** Bounded retry with linear backoff for transient network errors / 5xx. */
  private async withRetry(fn: () => Promise<any>, attempts = 3): Promise<any> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fn();
        if (res && typeof res.status === 'number' && res.status >= 500 && i < attempts - 1) {
          await delay(250 * (i + 1));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await delay(250 * (i + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

async function safeJson(res: any): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
