import { CountryProfile } from '../config/countryProfile';
import { MobileMoneyProvider } from './mobileMoneyProvider';
import { MockMoMoClient } from './mockMoMoClient';
import { MoMoClient, MoMoConfig } from './momoClient';

/**
 * Resolves the right mobile-money adapter for a market from its CountryProfile.
 * Adding an operator family = one more case here; nothing else in the rail
 * changes. Instances are cached per operator.
 */
export class ProviderRegistry {
  private cache = new Map<string, MobileMoneyProvider>();

  constructor(
    private readonly deps: {
      getMoMoConfig?: (operator: string) => MoMoConfig;
    } = {},
  ) {}

  resolve(profile: CountryProfile): MobileMoneyProvider {
    const cacheKey = `${profile.providerKey}:${profile.momoOperator}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let provider: MobileMoneyProvider;
    switch (profile.providerKey) {
      case 'momo_mock':
        provider = new MockMoMoClient(profile.momoOperator);
        break;
      case 'momo': {
        if (!this.deps.getMoMoConfig) throw new Error(`No MoMo config resolver wired for ${profile.momoOperator}`);
        provider = new MoMoClient(profile.momoOperator, this.deps.getMoMoConfig(profile.momoOperator));
        break;
      }
      // case 'daraja': provider = new DarajaClient(...); break;  // Kenya parity adapter
      default:
        throw new Error(`Unknown providerKey "${profile.providerKey}" for ${profile.code}`);
    }
    this.cache.set(cacheKey, provider);
    return provider;
  }
}
