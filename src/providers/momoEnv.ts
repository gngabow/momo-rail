import { MoMoConfig } from './momoClient';

/**
 * Resolve a MoMoConfig for an operating company from environment variables, and
 * decide which markets run against the *real* MTN adapter vs the mock.
 *
 * Flipping a market live is pure config — no code change:
 *   MOMO_LIVE_MARKETS=UG            # comma list of ISO codes to run on real MTN
 *   MOMO_BASE_URL=https://sandbox.momodeveloper.mtn.com
 *   MOMO_TARGET_ENV=sandbox        # sandbox, or the production env name per OpCo
 *   MOMO_CALLBACK_URL=https://momo.airtimepap.com/api/momo/callback/collection
 *
 * Credentials resolve most-specific-first, so one sandbox app can serve every
 * market while production overrides per operator:
 *   MTN_UG_COLLECTION_SUBKEY / MTN_UG_DISBURSEMENT_SUBKEY / MTN_UG_API_USER / MTN_UG_API_KEY
 * fall back to the shared:
 *   MOMO_COLLECTION_SUBKEY / MOMO_DISBURSEMENT_SUBKEY / MOMO_API_USER / MOMO_API_KEY
 */

const DEFAULT_SANDBOX_URL = 'https://sandbox.momodeveloper.mtn.com';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** most-specific-first: MTN_UG_FOO, then MOMO_FOO */
function operatorEnv(operator: string, suffix: string): string | undefined {
  return env(`${operator}_${suffix}`) ?? env(`MOMO_${suffix}`);
}

export function getMoMoConfigFromEnv(operator: string): MoMoConfig {
  const collectionSubscriptionKey = operatorEnv(operator, 'COLLECTION_SUBKEY');
  const apiUser = operatorEnv(operator, 'API_USER');
  const apiKey = operatorEnv(operator, 'API_KEY');

  const missing: string[] = [];
  if (!collectionSubscriptionKey) missing.push(`${operator}_COLLECTION_SUBKEY (or MOMO_COLLECTION_SUBKEY)`);
  if (!apiUser) missing.push(`${operator}_API_USER (or MOMO_API_USER)`);
  if (!apiKey) missing.push(`${operator}_API_KEY (or MOMO_API_KEY)`);
  if (missing.length) {
    throw new Error(`MoMo config for ${operator} is incomplete — missing: ${missing.join(', ')}. ` +
      `Provision a sandbox user with "npm run momo:provision" and set these before flipping ${operator} live.`);
  }

  return {
    baseUrl: env('MOMO_BASE_URL') ?? DEFAULT_SANDBOX_URL,
    targetEnvironment: env('MOMO_TARGET_ENV') ?? 'sandbox',
    collectionSubscriptionKey: collectionSubscriptionKey!,
    disbursementSubscriptionKey: operatorEnv(operator, 'DISBURSEMENT_SUBKEY'),
    apiUser: apiUser!,
    apiKey: apiKey!,
    callbackUrl: env('MOMO_CALLBACK_URL'),
  };
}

/** ISO codes that should run on the real MTN adapter (from MOMO_LIVE_MARKETS). */
export function liveMarkets(): Set<string> {
  const raw = env('MOMO_LIVE_MARKETS');
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
}

export function providerEnvName(): 'sandbox' | 'production' {
  return (env('MOMO_TARGET_ENV') ?? 'sandbox') === 'sandbox' ? 'sandbox' : 'production';
}
