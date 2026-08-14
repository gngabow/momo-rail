import { Ledger, UnbalancedEntryError, InsufficientBalanceError } from '../src/ledger/ledger';

describe('double-entry ledger', () => {
  test('a balanced entry moves value and balances to zero per currency', () => {
    const l = new Ledger();
    const a = l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    l.postEntry({ entryType: 'test', lines: [
      { accountId: a.id, amount: '-500.00' },
      { accountId: b.id, amount: '500.00' },
    ]});
    expect(l.getBalance(b.id).balance).toBe('500.00');
    expect(l.getBalance(a.id).balance).toBe('-500.00');
  });

  test('an unbalanced entry is rejected', () => {
    const l = new Ledger();
    const a = l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    expect(() => l.postEntry({ entryType: 'bad', lines: [
      { accountId: a.id, amount: '-500.00' },
      { accountId: b.id, amount: '499.99' },
    ]})).toThrow(UnbalancedEntryError);
  });

  test('multi-currency entry balances each currency independently', () => {
    const l = new Ledger();
    const kesA = l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const kesB = l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    const usdtA = l.createAccount({ currency: 'USDT', accountType: 'system_usdt_hot_wallet' });
    const usdtB = l.createAccount({ customerId: 'c1', currency: 'USDT', accountType: 'customer_wallet' });
    l.postEntry({ entryType: 'convert', lines: [
      { accountId: kesA.id, amount: '-12900.00' },
      { accountId: kesB.id, amount: '12900.00' },
      { accountId: usdtA.id, amount: '-100.000000' },
      { accountId: usdtB.id, amount: '100.000000' },
    ]});
    expect(l.getBalance(usdtB.id).balance).toBe('100.000000');
  });

  test('idempotency: same key applies once', () => {
    const l = new Ledger();
    const a = l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    const e1 = l.postEntry({ entryType: 't', idempotencyKey: 'k1', lines: [
      { accountId: a.id, amount: '-100.00' }, { accountId: b.id, amount: '100.00' },
    ]});
    const e2 = l.postEntry({ entryType: 't', idempotencyKey: 'k1', lines: [
      { accountId: a.id, amount: '-100.00' }, { accountId: b.id, amount: '100.00' },
    ]});
    expect(e2.id).toBe(e1.id);
    expect(l.getBalance(b.id).balance).toBe('100.00'); // applied once, not twice
  });

  test('assertSufficientBalance guards', () => {
    const l = new Ledger();
    const b = l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    expect(() => l.assertSufficientBalance(b.id, '1.00')).toThrow(InsufficientBalanceError);
  });
});
