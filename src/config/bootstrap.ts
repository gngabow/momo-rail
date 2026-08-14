import { Ledger } from '../ledger/ledger';
import { CountryProfile, CountryRegistry, seedProfiles } from './countryProfile';

/**
 * Wire up a runnable rail: create the system ledger accounts every seeded
 * profile references, and register the profiles. Deterministic account IDs so
 * a CountryProfile can reference them by config (production bakes real seeded
 * IDs the same way).
 */
export function bootstrap(): { ledger: Ledger; registry: CountryRegistry; profiles: CountryProfile[] } {
  const ledger = new Ledger();
  const registry = new CountryRegistry();
  const profiles = seedProfiles();
  const created = new Set<string>();

  const ensure = (id: string, currency: string, accountType: Parameters<Ledger['createAccount']>[0]['accountType'], countryCode: string | null) => {
    if (created.has(id)) return;
    ledger.createAccount({ id, currency, accountType, countryCode });
    created.add(id);
  };

  for (const p of profiles) {
    ensure(p.ledgerAccounts.usdtHotWalletId, 'USDT', 'system_usdt_hot_wallet', null);
    ensure(p.ledgerAccounts.usdtFeeRevenueId, 'USDT', 'system_fee_revenue', null);
    ensure(p.ledgerAccounts.localFloatId, p.localCurrency, 'system_local_float', p.code);
    ensure(p.ledgerAccounts.localFeeRevenueId, p.localCurrency, 'system_fee_revenue', p.code);
    registry.upsert(p);
  }

  return { ledger, registry, profiles };
}
