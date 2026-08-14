import { Account, Ledger } from '../ledger/ledger';

/** Idempotently provision a customer's wallet for a currency. */
export function provisionWallet(ledger: Ledger, customerId: string, currency: string, countryCode: string | null): Account {
  const existing = ledger.findCustomerWallet(customerId, currency);
  if (existing) return existing;
  return ledger.createAccount({ customerId, currency, accountType: 'customer_wallet', countryCode });
}
