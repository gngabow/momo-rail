import { Ledger, UnbalancedEntryError, InsufficientBalanceError } from '../src/ledger/ledger';

describe('double-entry ledger', () => {
  test('a balanced entry moves value and balances to zero per currency', async () => {
    const l = new Ledger();
    const a = await l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = await l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    await l.postEntry({ entryType: 'test', lines: [
      { accountId: a.id, amount: '-500.00' },
      { accountId: b.id, amount: '500.00' },
    ]});
    expect((await l.getBalance(b.id)).balance).toBe('500.00');
    expect((await l.getBalance(a.id)).balance).toBe('-500.00');
  });

  test('an unbalanced entry is rejected', async () => {
    const l = new Ledger();
    const a = await l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = await l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    await expect(l.postEntry({ entryType: 'bad', lines: [
      { accountId: a.id, amount: '-500.00' },
      { accountId: b.id, amount: '499.99' },
    ]})).rejects.toThrow(UnbalancedEntryError);
  });

  test('multi-currency entry balances each currency independently', async () => {
    const l = new Ledger();
    const kesA = await l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const kesB = await l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    const usdtA = await l.createAccount({ currency: 'USDT', accountType: 'system_usdt_hot_wallet' });
    const usdtB = await l.createAccount({ customerId: 'c1', currency: 'USDT', accountType: 'customer_wallet' });
    await l.postEntry({ entryType: 'convert', lines: [
      { accountId: kesA.id, amount: '-12900.00' },
      { accountId: kesB.id, amount: '12900.00' },
      { accountId: usdtA.id, amount: '-100.000000' },
      { accountId: usdtB.id, amount: '100.000000' },
    ]});
    expect((await l.getBalance(usdtB.id)).balance).toBe('100.000000');
  });

  test('idempotency: same key applies once', async () => {
    const l = new Ledger();
    const a = await l.createAccount({ currency: 'KES', accountType: 'system_local_float' });
    const b = await l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    const e1 = await l.postEntry({ entryType: 't', idempotencyKey: 'k1', lines: [
      { accountId: a.id, amount: '-100.00' }, { accountId: b.id, amount: '100.00' },
    ]});
    const e2 = await l.postEntry({ entryType: 't', idempotencyKey: 'k1', lines: [
      { accountId: a.id, amount: '-100.00' }, { accountId: b.id, amount: '100.00' },
    ]});
    expect(e2.id).toBe(e1.id);
    expect((await l.getBalance(b.id)).balance).toBe('100.00'); // applied once, not twice
  });

  test('assertSufficientBalance guards', async () => {
    const l = new Ledger();
    const b = await l.createAccount({ customerId: 'c1', currency: 'KES', accountType: 'customer_wallet' });
    await expect(l.assertSufficientBalance(b.id, '1.00')).rejects.toThrow(InsufficientBalanceError);
  });
});
