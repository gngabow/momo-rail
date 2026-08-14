import { newId } from '../util/id';

/**
 * MTN MoMo sandbox self-provisioning. The sandbox lets you mint an API user +
 * API key yourself from a subscription key (the one you copy from your product
 * subscription at momodeveloper.mtn.com). Production credentials, by contrast,
 * are issued by each operating company — but the client code is identical.
 *
 *   1. POST /v1_0/apiuser            (X-Reference-Id = the new API user UUID)
 *   2. POST /v1_0/apiuser/{id}/apikey  -> { apiKey }
 *   3. GET  /v1_0/apiuser/{id}        (confirm)
 */
const httpFetch: (url: string, init?: unknown) => Promise<any> = (globalThis as any).fetch;

export interface ProvisionResult {
  apiUser: string;
  apiKey: string;
  callbackHost: string;
  baseUrl: string;
}

export async function provisionSandboxUser(opts: {
  baseUrl?: string;
  subscriptionKey: string;      // Ocp-Apim-Subscription-Key (product subscription)
  callbackHost?: string;        // bare host, no scheme, e.g. "momo.airtimepap.com"
}): Promise<ProvisionResult> {
  if (!httpFetch) throw new Error('global fetch unavailable — Node 18+ required');
  const baseUrl = opts.baseUrl ?? 'https://sandbox.momodeveloper.mtn.com';
  const callbackHost = opts.callbackHost ?? 'momo.airtimepap.com';
  const apiUser = newId();
  const sub = opts.subscriptionKey;

  // 1) create the API user
  const createRes = await httpFetch(`${baseUrl}/v1_0/apiuser`, {
    method: 'POST',
    headers: {
      'X-Reference-Id': apiUser,
      'Ocp-Apim-Subscription-Key': sub,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ providerCallbackHost: callbackHost }),
  });
  if (createRes.status !== 201) {
    const b = await safeText(createRes);
    throw new Error(`create apiuser failed (${createRes.status}): ${b}`);
  }

  // 2) mint an API key for it
  const keyRes = await httpFetch(`${baseUrl}/v1_0/apiuser/${apiUser}/apikey`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': sub },
  });
  if (keyRes.status !== 201) {
    const b = await safeText(keyRes);
    throw new Error(`create apikey failed (${keyRes.status}): ${b}`);
  }
  const keyBody = await keyRes.json();
  const apiKey = String(keyBody.apiKey);

  // 3) confirm
  const check = await httpFetch(`${baseUrl}/v1_0/apiuser/${apiUser}`, {
    method: 'GET',
    headers: { 'Ocp-Apim-Subscription-Key': sub },
  });
  if (!check.ok) {
    const b = await safeText(check);
    throw new Error(`confirm apiuser failed (${check.status}): ${b}`);
  }

  return { apiUser, apiKey, callbackHost, baseUrl };
}

async function safeText(res: any): Promise<string> {
  try { return await res.text(); } catch { return '<no body>'; }
}
