/**
 * One-shot: mint an MTN MoMo *sandbox* API user + API key from your subscription
 * key, and print the env lines to paste into your deployment.
 *
 *   MOMO_SUBSCRIPTION_KEY=xxxx\
 *   MOMO_CALLBACK_HOST=momo.airtimepap.com\
 *   npm run momo:provision
 *
 * Get MOMO_SUBSCRIPTION_KEY by registering at https://momodeveloper.mtn.com,
 * subscribing to the "Collections" product, and copying its Primary Key.
 * (Subscribe to "Disbursements" too and pass its key as the disbursement subkey.)
 */
import { provisionSandboxUser } from '../src/providers/momoProvision';

async function main() {
  const subscriptionKey = process.env.MOMO_SUBSCRIPTION_KEY || process.argv[2];
  const callbackHost = process.env.MOMO_CALLBACK_HOST || process.argv[3] || 'momo.airtimepap.com';
  const baseUrl = process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';

  if (!subscriptionKey) {
    console.error('Missing MOMO_SUBSCRIPTION_KEY. Get one at https://momodeveloper.mtn.com (subscribe to Collections, copy the Primary Key).');
    console.error('Usage: MOMO_SUBSCRIPTION_KEY=xxxx npm run momo:provision');
    process.exit(1);
  }

  console.log(`Provisioning a sandbox API user at ${baseUrl} (callback host: ${callbackHost}) …`);
  const r = await provisionSandboxUser({ baseUrl, subscriptionKey, callbackHost });

  console.log('\n✅ Provisioned. Add these to your environment (Render → Environment):\n');
  console.log(`MOMO_BASE_URL=${r.baseUrl}`);
  console.log('MOMO_TARGET_ENV=sandbox');
  console.log(`MOMO_COLLECTION_SUBKEY=${subscriptionKey}`);
  console.log('# MOMO_DISBURSEMENT_SUBKEY=<Disbursements product Primary Key, if different>');
  console.log(`MOMO_API_USER=${r.apiUser}`);
  console.log(`MOMO_API_KEY=${r.apiKey}`);
  console.log(`MOMO_CALLBACK_URL=https://${r.callbackHost}/api/momo/callback/collection`);
  console.log('MOMO_LIVE_MARKETS=UG   # flip Uganda onto the real MTN adapter\n');
}

main().catch((e) => { console.error('Provisioning failed:', e.message || e); process.exit(1); });
