import { bootstrap } from '../src/config/bootstrap';
import { ProviderRegistry } from '../src/providers/registry';
import { FixedFxRateProvider } from '../src/fx/fxRateProvider';
import { RailService } from '../src/rail/railService';
import { PayrollService } from '../src/payroll/payrollService';

describe('payroll (bulk MoMo disbursement)', () => {
  test('pays workers until the employer float runs out, debiting only the paid ones', async () => {
    const { ledger, registry } = await bootstrap();
    const providers = new ProviderRegistry();
    const rail = new RailService(ledger, registry, providers, new FixedFxRateProvider());
    const payroll = new PayrollService(ledger, registry, providers);

    await rail.deposit('UG', { customerId: 'emp', national: '772123456', amountLocal: '120000' });
    const res = await payroll.runBatch('UG', {
      employerCustomerId: 'emp',
      payees: [
        { national: '772111111', amountLocal: '100000', label: 'Mary' },
        { national: '772222222', amountLocal: '50000', label: 'John' },
      ],
    });

    expect(res.paid).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.items[1].reason).toMatch(/insufficient/i);
    expect((await ledger.getBalance((await ledger.findCustomerWallet('emp', 'UGX'))!.id)).balance).toBe('20000');
  });
});
