/**
 * Auth + ops-console proof (in-memory). Run: `ts-node -T tests/verify-auth.ts`.
 * Covers: OTP request/verify, session resolve, wrong-code rejection, admin
 * login (env creds), and a writing ops-console market edit that takes effect
 * live and is re-applied from the override store on a fresh boot.
 */
import { AuthService, AuthError, customerIdFor } from '../src/auth/authService';
import { OpsService, InMemoryOverrideStore } from '../src/ops/opsService';
import { CountryRegistry, seedProfiles } from '../src/config/countryProfile';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
async function throws(name: string, fn: () => unknown) {
  try { await fn(); fail++; console.log(`  FAIL ${name} (did not throw)`); }
  catch { pass++; console.log(`  ok  ${name}`); }
}

function freshRegistry(): CountryRegistry {
  const r = new CountryRegistry();
  for (const p of seedProfiles()) r.upsert(p);
  return r;
}

async function main() {
  console.log('\nauth (customer OTP + sessions)');
  {
    const auth = new AuthService(freshRegistry());
    const req = auth.requestOtp('UG', '772123456');
    ok('OTP issued with dev code (no SMS provider)', !!req.devCode && req.devCode.length === 6);
    await throws('wrong code rejected', () => auth.verifyOtp('UG', '772123456', '000000' === req.devCode ? '111111' : '000000'));
    // fresh OTP (the wrong attempt above counts against the same code; request a new one)
    const req2 = auth.requestOtp('UG', '772123456');
    const v = auth.verifyOtp('UG', '772123456', req2.devCode!);
    ok('correct code -> session token', !!v.token && v.token.length > 20);
    ok('customer id derived from phone', v.customerId === customerIdFor('UG', '256772123456'));
    const s = auth.resolve(v.token);
    ok('session resolves to customer', !!s && s.kind === 'customer' && s.subject === v.customerId);
    auth.logout(v.token);
    ok('logout invalidates session', auth.resolve(v.token) === undefined);
    ok('unknown token -> no session', auth.resolve('deadbeef') === undefined);
  }

  console.log('admin (env credentials)');
  {
    const auth = new AuthService(freshRegistry());
    process.env.ADMIN_USERNAME = 'ops';
    process.env.ADMIN_PASSWORD = 's3cret';
    await throws('bad admin password rejected', () => auth.adminLogin('ops', 'nope'));
    const a = auth.adminLogin('ops', 's3cret');
    ok('admin login -> admin session', !!a.token && auth.resolve(a.token)!.kind === 'admin');
    delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD;
  }

  console.log('ops console (writing, durable, live effect)');
  {
    const registry = freshRegistry();
    const store = new InMemoryOverrideStore();
    const ops = new OpsService(registry, store);

    ok('GH starts enabled on mock adapter', registry.get('GH').enabled === true && registry.get('GH').providerKey === 'momo_mock');
    await ops.updateMarket('GH', { enabled: false, feeSchedule: { convertRate: 0.02 } });
    ok('edit takes effect live', registry.get('GH').enabled === false && registry.get('GH').feeSchedule.convertRate === 0.02);
    await throws('bad providerKey rejected', () => ops.updateMarket('GH', { providerKey: 'bogus' }));

    // Fresh boot: seed defaults, then re-apply overrides from the same store.
    const registry2 = freshRegistry();
    ok('fresh registry has defaults again', registry2.get('GH').enabled === true);
    const ops2 = new OpsService(registry2, store);
    const applied = await ops2.loadOverrides();
    ok('overrides re-applied on boot', applied === 1 && registry2.get('GH').enabled === false && registry2.get('GH').feeSchedule.convertRate === 0.02);
  }

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} assertions, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
