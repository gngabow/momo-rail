import { CountryProfile } from '../config/countryProfile';
import { toMinor } from '../ledger/money';

export type ScreeningDecision = 'pass' | 'review' | 'block';

/**
 * Per-country transaction screening. Thresholds and the block-on-sanctions rule
 * come from the CountryProfile, so each market screens by its own regime through
 * one code path. Mock sanctions match here (a real vendor sits behind the same
 * seam as the mobile-money provider).
 */
export function screenTransaction(
  profile: CountryProfile,
  params: { customerId: string; amountLocal: string; sanctionsHit?: boolean },
): { decision: ScreeningDecision; reason?: string } {
  if (params.sanctionsHit && profile.screening.blockOnSanctionsHit) {
    return { decision: 'block', reason: 'Sanctions screening match' };
  }
  const amt = toMinor(params.amountLocal, profile.localCurrency);
  const threshold = toMinor(profile.screening.reviewThresholdLocal, profile.localCurrency);
  if (amt >= threshold) return { decision: 'review', reason: 'Above review threshold' };
  return { decision: 'pass' };
}
