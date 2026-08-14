import { CountryProfile } from '../config/countryProfile';

/** Combine a market dial code with a national number into a canonical bare
 * MSISDN, tolerant of a leading 0, +, or the country code already present. */
export function toMsisdn(profile: CountryProfile, national: string): string {
  let n = (national || '').replace(/\D/g, '').replace(/^00/, '');
  if (n.startsWith(profile.dialCode)) return n;
  n = n.replace(/^0+/, '');
  return profile.dialCode + n;
}

/** Validate the national portion against the market's rule. */
export function isValidNational(profile: CountryProfile, national: string): boolean {
  const n = (national || '').replace(/\D/g, '').replace(/^0+/, '');
  return new RegExp(profile.phoneRegex).test(n);
}
