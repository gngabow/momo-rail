import { CountryProfile, CountryRegistry } from '../config/countryProfile';

/**
 * The writing ops console. Lets an admin change a market's config at runtime —
 * enable/disable it, adjust fees or limits, flip its adapter mock<->live — and
 * have it take effect immediately on the live registry. Edits are persisted as
 * a patch per market so they survive a restart (Postgres when DATABASE_URL is
 * set; in-memory otherwise) and are re-applied over the code-seeded defaults on
 * boot.
 */
export interface MarketPatch {
  enabled?: boolean;
  providerKey?: string;
  providerEnv?: 'sandbox' | 'production';
  merchantModel?: CountryProfile['merchantModel'];
  feeSchedule?: Partial<CountryProfile['feeSchedule']>;
  limits?: Partial<CountryProfile['limits']>;
  features?: Partial<CountryProfile['features']>;
}

export interface ProfileOverrideStore {
  save(code: string, patch: MarketPatch): Promise<void>;
  loadAll(): Promise<Record<string, MarketPatch>>;
  init?(): Promise<void>;
}

export class InMemoryOverrideStore implements ProfileOverrideStore {
  private m = new Map<string, MarketPatch>();
  async save(code: string, patch: MarketPatch): Promise<void> {
    const k = code.toUpperCase();
    this.m.set(k, mergePatch(this.m.get(k), patch));
  }
  async loadAll(): Promise<Record<string, MarketPatch>> {
    const o: Record<string, MarketPatch> = {};
    for (const [k, v] of this.m) o[k] = v;
    return o;
  }
}

export function mergePatch(base: MarketPatch | undefined, patch: MarketPatch): MarketPatch {
  return {
    ...base, ...patch,
    feeSchedule: { ...(base?.feeSchedule), ...(patch.feeSchedule) },
    limits: { ...(base?.limits), ...(patch.limits) },
    features: { ...(base?.features), ...(patch.features) },
  };
}

/** Apply a patch onto a live CountryProfile (mutates in place). */
export function applyPatch(p: CountryProfile, patch: MarketPatch): CountryProfile {
  if (patch.enabled !== undefined) p.enabled = patch.enabled;
  if (patch.providerKey) p.providerKey = patch.providerKey;
  if (patch.providerEnv) p.providerEnv = patch.providerEnv;
  if (patch.merchantModel) p.merchantModel = patch.merchantModel;
  if (patch.feeSchedule) p.feeSchedule = { ...p.feeSchedule, ...patch.feeSchedule };
  if (patch.limits) p.limits = { ...p.limits, ...patch.limits };
  if (patch.features) p.features = { ...p.features, ...patch.features };
  return p;
}

export class OpsError extends Error {}

export class OpsService {
  constructor(private readonly registry: CountryRegistry, private readonly store: ProfileOverrideStore) {}

  async updateMarket(code: string, patch: MarketPatch): Promise<CountryProfile> {
    const profile = this.registry.get(code); // throws if unknown
    if (patch.providerKey && !['momo', 'momo_mock', 'daraja'].includes(patch.providerKey)) {
      throw new OpsError(`Unknown providerKey "${patch.providerKey}"`);
    }
    applyPatch(profile, patch);
    this.registry.upsert(profile);
    await this.store.save(code, patch);
    return profile;
  }

  /** Re-apply persisted overrides over the seeded defaults (call once on boot). */
  async loadOverrides(): Promise<number> {
    const all = await this.store.loadAll();
    let applied = 0;
    for (const [code, patch] of Object.entries(all)) {
      try { applyPatch(this.registry.get(code), patch); applied++; } catch { /* stale code — skip */ }
    }
    return applied;
  }
}
