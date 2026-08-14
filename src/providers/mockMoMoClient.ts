import { newId } from '../util/id';
import {
  CollectRequest, DisburseRequest, MobileMoneyProvider, NormalizedCallback, ProviderResult,
} from './mobileMoneyProvider';

/**
 * Honest mock of a MoMo operator — lets every rail flow (deposit, convert,
 * withdraw, payroll) be built and tested before a real MTN operating-company
 * credential exists. Deliberately able to simulate failure, not just success:
 * a subscriber can decline the prompt, a disbursement can bounce, and the rail
 * everywhere else is built to handle a real failure path.
 *
 * Failure hooks for tests: a subscriber whose MSISDN ends in "0000" declines
 * collections; construct with { failCollect } / { failDisburse } to force it.
 */
export class MockMoMoClient implements MobileMoneyProvider {
  readonly key: string;
  private byReference = new Map<string, ProviderResult>();

  constructor(
    private readonly operator = 'MTN_MOCK',
    private readonly opts: { failCollect?: boolean; failDisburse?: boolean } = {},
  ) {
    this.key = `momo_mock:${operator}`;
  }

  async collect(req: CollectRequest): Promise<ProviderResult> {
    const declined = this.opts.failCollect || req.msisdn.endsWith('0000');
    const res: ProviderResult = declined
      ? { providerRef: '', status: 'failed', failureReason: 'Subscriber declined the collection prompt' }
      : { providerRef: `momo-collect-${newId()}`, status: 'success' };
    this.byReference.set(req.reference, res);
    return res;
  }

  async disburse(req: DisburseRequest): Promise<ProviderResult> {
    const failed = this.opts.failDisburse;
    const res: ProviderResult = failed
      ? { providerRef: '', status: 'failed', failureReason: 'Disbursement rejected by operator' }
      : { providerRef: `momo-disburse-${newId()}`, status: 'success' };
    this.byReference.set(req.reference, res);
    return res;
  }

  async status(reference: string): Promise<ProviderResult> {
    return this.byReference.get(reference) ?? { providerRef: '', status: 'pending' };
  }

  handleCallback(payload: unknown): NormalizedCallback {
    const p = (payload ?? {}) as Record<string, unknown>;
    return {
      reference: String(p.reference ?? ''),
      providerRef: String(p.providerRef ?? ''),
      status: (p.status as NormalizedCallback['status']) ?? 'pending',
      failureReason: p.failureReason ? String(p.failureReason) : undefined,
    };
  }
}
