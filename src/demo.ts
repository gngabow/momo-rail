import { bootstrap } from './config/bootstrap';
import { ProviderRegistry } from './providers/registry';
import { FixedFxRateProvider } from './fx/fxRateProvider';
import { RailService } from './rail/railService';

/** Runnable proof: the same code path serves two markets on two currencies. */
async function main() {
  const { ledger, registry } = await bootstrap();
  const rail = new RailService(ledger, registry, new ProviderRegistry(), new FixedFxRateProvider());

  const all = registry.list();
  console.log(`Configured MoMo markets: ${all.length}`);
  console.log(all.map((p) => `${p.code}:${p.localCurrency}`).join('  '));

  const scenarios = [
    { country: 'UG', national: '772123456', deposit: '400000', convert: '380000' },
    { country: 'GH', national: '241234567', deposit: '2000', convert: '1550' },
  ] as const;

  for (const s of scenarios) {
    const profile = registry.require(s.country);
    const customerId = `cust-${s.country}`;
    console.log(`\n=== ${profile.displayName} · ${profile.localCurrency} · ${profile.momoOperator} ===`);

    const dep = await rail.deposit(s.country, { customerId, national: s.national, amountLocal: s.deposit });
    console.log(`deposit ${s.deposit} ${profile.localCurrency} -> ${dep.status} (screen: ${dep.screen})`);

    const cvt = await rail.convert(s.country, { customerId, direction: 'local_to_usdt', amount: s.convert });
    console.log(`convert ${s.convert} ${profile.localCurrency} -> ${cvt.quote.net} USDT (fee ${cvt.quote.fee} USDT @ ${cvt.quote.rateLocalPerUsdt})`);

    const back = await rail.convert(s.country, { customerId, direction: 'usdt_to_local', amount: '25' });
    console.log(`convert 25 USDT -> ${back.quote.net} ${profile.localCurrency} (fee ${back.quote.fee} ${profile.localCurrency})`);

    const wd = await rail.withdraw(s.country, { customerId, national: s.national, amountLocal: back.quote.net });
    console.log(`withdraw ${back.quote.net} ${profile.localCurrency} -> ${wd.status}`);

    const local = await ledger.getBalance(cvt.localWalletId);
    const usdt = await ledger.getBalance(cvt.usdtWalletId);
    console.log(`balances: ${local.balance} ${local.currency} · ${usdt.balance} USDT`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
