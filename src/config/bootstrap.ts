import { Ledger } from '../ledger/ledger';
import { LedgerStore } from '../ledger/store';
import { CountryProfile, CountryRegistry, seedProfiles } from './countryProfile';
import { liveMarkets, providerEnvName } from '../providers/momoEnv';

/**
 * Wire up a runnable rail: create the system ledger accounts every seeded
 * profile references, and register the profiles. Deterministic account IDs so
 * a CountryProfile can reference them by config (production bakes real seeded
 * IDs the same way).
 */
export async function bootstrap(ledgerImpl?: LedgerStore): Promise<{ ledger: LedgerStore; registry: CountryRegistry; profiles: CountryProfile[] }> {
  const ledger: LedgerStore = ledgerImpl ?? new Ledger();
  if (ledger.init) await ledger.init();
  const registry = new CountryRegistry();
  const profiles = seedProfiles();
  const created = new Set<string>();

  // Env-driven mock->live flip: MOMO_LIVE_MARKETS=UG,GH runs those on the real MTN adapter.
  const live = liveMarkets();
  const envName = providerEnvName();

  const ensure = async (id: string, currency: string, accountType: Parameters<LedgerStore['createAccount']>[0]['accountType'], countryCode: string | null) => {
    if (created.has(id)) return;
    // Idempotent across restarts: a durable store may already hold this account.
    try { await ledger.getAccount(id); created.add(id); return; } catch { /* not present — create it */ }
    await ledger.createAccount({ id, currency, accountType, countryCode });
    created.add(id);
  };

  for (const p of profiles) {
    if (live.has(p.code.toUpperCase())) {
      p.providerKey = 'momo';
      p.providerEnv = envName;
      p.licensing = { ...p.licensing, note: `Live on MTN ${envName} adapter` };
    }
    await ensure(p.ledgerAccounts.usdtHotWalletId, 'USDT', 'system_usdt_hot_wallet', null);
    await ensure(p.ledgerAccounts.usdtFeeRevenueId, 'USDT', 'system_fee_revenue', null);
    await ensure(p.ledgerAccounts.localFloatId, p.localCurrency, 'system_local_float', p.code);
    await ensure(p.ledgerAccounts.localFeeRevenueId, p.localCurrency, 'system_fee_revenue', p.code);
    await ensure(`sys-${p.localCurrency}-suspense`, p.localCurrency, 'system_suspense', p.code);
    await ensure(`sys-${p.localCurrency}-biller`, p.localCurrency, 'system_biller', p.code);
    registry.upsert(p);
  }

  // Shared USDT remittance escrow (holds reserved funds until the recipient claims).
  await ensure('sys-USDT-remit-escrow', 'USDT', 'system_remittance_escrow', null);

  return { ledger, registry, profiles };
}
