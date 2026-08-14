import { Account } from '../ledger/ledger';
import { LedgerStore } from '../ledger/store';

/** Idempotently provision a customer's wallet for a currency. */
export async function provisionWallet(ledger: LedgerStore, customerId: string, currency: string, countryCode: string | null): Promise<Account> {
  const existing = await ledger.findCustomerWallet(customerId, currency);
  if (existing) return existing;
  return ledger.createAccount({ customerId, currency, accountType: 'customer_wallet', countryCode });
}
