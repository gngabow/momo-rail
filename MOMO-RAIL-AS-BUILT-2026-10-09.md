# MoMo ⇄ USDT rail — as built

**Read from the code on 9 October 2026**, in `C:\mup\momo-rail`. The tree itself
was last touched **17 August 2026** and has not moved since, so this describes a
project that is parked, not one in flight.

**Where this sits.** It is a separate repo from the M-Pesa/KES platform and always
was. The KES build's own `render.yaml` once ran a service called `MoMo-OneInAll`;
that service was retired on 14 September (D-353) along with the standalone fiat
wallet app, and the code here is the standalone rail that work came from. **Nothing
in this document is in the M-Pesa repo.**

**One caution before anything else.** `README.md` in that repo carries struck-through
"not yet built" items and later sections that contradict earlier ones — it grew by
accretion. Where this document and that README disagree, this one was derived from
the tree today; but the tree is the only authority, and that is the house rule in
the other repo too. 54 TypeScript files, 2 migrations, 8 verification scripts.

---

## 1. The thesis, which is the reusable part

> One codebase, one deployment, every market as a record — not a fork.

`src/rail/railService.ts` never names a currency, a country or an operator. It
resolves the market's `CountryProfile` and reads everything from it.

**15 markets are seeded, and every one of them is MTN**: UG, GH, CI, CM, NG, RW, ZM,
BJ, CG, GN, GW, LR, SZ, ZA, SS. `MOMO_MARKETS` in `countryProfile.ts` is the list;
`toProfile` gives each one `momoOperator: MTN_<code>`, `providerKey: 'momo_mock'`
and `providerEnv: 'sandbox'`, and only Uganda is marked `tested: true`.

**THERE IS NO KENYA PROFILE.** The README says the demo runs *"Uganda and Kenya
through that same file"* and that the portal switches across *"all 16 markets"*.
Neither is true of the tree today: `grep` for `'KE'` across `src/` returns nothing,
and `KES` appears only as a CURRENCY in the ledger and money tests. That claim is
either stale or was always about the ledger being currency-agnostic rather than
about a seeded market. **Read the tree.**

---

## 2. `CountryProfile` — the record that replaces the fork

`src/config/countryProfile.ts`. One record per market holds everything a
single-country build would hardcode:

| group | fields |
|---|---|
| money & identity | `localCurrency`, `dialCode`, `phoneRegex`, `msisdnFormat` (`bare`/`plus`) |
| rail adapter | `momoOperator` (e.g. `MTN_UG`), `providerKey` (see the caution below), `providerEnv` |
| economics | `feeSchedule` (convert, remittance, merchant-pay rates), `limits.perTxMaxLocal`, `ledgerAccounts` |
| products | `features.{walletConvert, inboundRemittance, outboundRemittance, payroll, merchantPay, agents}`, `merchantModel` (`momopay` / `paybill_till` / `none`) |
| compliance | `kycProviderKey`, `sanctionsProviderKey`, `screening.{reviewThresholdLocal, blockOnSanctionsHit}`, `licensing.{vaspLicensed, regime, note}` |

**Two details worth copying rather than the shape alone:**

- **`require(code)` is the entry point money-movement code uses**, and it is
  different from `get(code)`: it throws `CountryDisabledError` for a profile that
  exists but is switched off. Disabled is not the same as absent, and the caller is
  told which.
- **`features.*` and `licensing.vaspLicensed` gate what is legally live**, per
  market, as data. Turning a product off in a country is an edit to a row, not a
  deploy.

Adding a market is: add the profile, point `providerKey` at an adapter, seed that
market's float and fee-revenue accounts, set the feature and licensing flags. No
business logic changes.

---

## 3. Money: integer minor units, scale from the currency

`src/ledger/money.ts`. Every amount is an **integer in the currency's minor unit**,
and the scale is a property of the currency:

```
USDT 6   USDC 6
KES  2   (and the other two-decimal currencies)
UGX  0   RWF 0   XOF 0   XAF 0   GNF 0
```

**The Ugandan shilling has no minor unit at all**, which is the case that breaks a
build assuming "cents". Holding the scale per currency rather than per codebase is
what lets one ledger serve all 16.

Every journal entry balances exactly, because integers.

---

## 4. The provider seam

`src/providers/mobileMoneyProvider.ts` — the file its own comment calls *"the single
most important seam in the rail."* Four methods, and every operator is reached
through them:

```
collect(req)        pull funds IN    MoMo Collections requesttopay · Daraja STK push
disburse(req)       push funds OUT   MoMo Disbursements transfer   · Daraja B2C
status(ref, product?)                product picks collection vs disbursement
handleCallback(payload)              normalises any webhook to one event shape
```

**CROSS-OPCO IS REAL. CROSS-OPERATOR IS NOT BUILT, AND THE TYPE COMMENT MISLEADS
ON THIS.** `CountryProfile.providerKey` is documented as resolving
`"momo" | "daraja" | "momo_mock"`, but `providers/registry.ts` implements exactly
two cases and carries the third as a comment:

```ts
// case 'daraja': provider = new DarajaClient(...); break;  // Kenya parity adapter
```

So the rail is **MTN across operating companies** — one `MoMoClient` parameterised
per OpCo, instances cached per operator, because MTN's Open API is common across
its markets and only credentials and target environment differ. A non-MTN operator
is a seam the design leaves open and nobody has filled; the registry throws
`Unknown providerKey` for anything else. Adding one is one more `case` here and
nothing else in the rail changes — which is the design working, not a gap in it,
but it has not been done.

Adapters actually present: `mockMoMoClient.ts` (tests and pre-credential dev) and
`momoClient.ts` (real MTN Open API — OAuth with token cache, `requesttopay`,
`transfer`, status poll, account balance). `momoProvision.ts` and
`npm run momo:provision` do sandbox provisioning. **Mock → live is a config flip**
— `MOMO_LIVE_MARKETS=UG,GH` in `bootstrap.ts` moves named markets onto the real
adapter — not a code change.

`NormalizedCallback` is `{ reference, providerRef, status, failureReason? }` —
every operator's payload collapses to that, so settlement code never sees a vendor
shape.

---

## 5. Pending settlement — the part the M-Pesa build learned the hard way too

`src/rail/settlement.ts`, and this is the design worth carrying into anything that
touches a mobile-money operator:

> A real MoMo collect/disburse returns **202 — accepted, not final**. The money only
> moves on the ledger when the operator confirms SUCCESSFUL via callback or status
> poll.

So the rail records the *intent* as a `PendingSettlement` and settles it **exactly
once** on the terminal event. A withdrawal **parks funds in a suspense account**
(`suspenseId`) until the disbursement confirms — it does not debit optimistically.

**The durable-sink pattern is also worth noting**: the in-memory map stays
authoritative at runtime so the hot path has no I/O churn, a `PendingSink` is
written through best-effort, and open items are **hydrated on boot** so a restart
does not lose things in flight. `pgPending.ts` is the Postgres implementation.

---

## 6. What is actually built

| area | file | state |
|---|---|---|
| rail flows | `rail/railService.ts` | deposit · convert · withdraw · settle |
| ledger | `ledger/ledger.ts`, `money.ts`, `store.ts`, `pgLedger.ts` | currency-agnostic double entry |
| markets | `config/countryProfile.ts`, `bootstrap.ts` | 16 profiles, registry, seeding |
| providers | `providers/*` | mock + real MTN client, env, provisioning, registry |
| exchange | `exchange/exchange.ts`, `fx/fxRateProvider.ts` | conversion and rates |
| payroll | `payroll/payrollService.ts` | batch disbursement |
| remittance | `remittance/remittanceService.ts` + claim store + pg sink | **invite / claim / refund**, with `quoteDelivery` |
| bill pay | `billers/billerService.ts` + pg sink | MoMoPay / biller directory |
| requests | `requests/requestService.ts` + pg sink | request-money |
| compliance | `compliance/screening.ts` | sanctions screening, review threshold |
| auth | `auth/adminStore.ts`, `authService.ts` | admin users, `seed:admin-user`, `set-admin-password` |
| ops | `ops/opsService.ts`, `pgOverrideStore.ts` | markets view, overrides |
| API + portal | `api/server.ts`, `web/index.html` | zero-dependency Node `http`, 17 endpoints |

**The remittance design is the other transferable one**: send creates a *claim* the
recipient redeems by code or MSISDN (`claim`, `claimAllFor`), with `refund` for one
nobody collects. It never assumes the recipient already has an account — which is
exactly the problem a cross-border rail has to solve.

**API surface**: `/api/markets · wallet · deposit · convert · withdraw · payroll ·
activity · pending · remit · request · bill · billers · momo · usdt · usdt-balance ·
admin · auth`.

---

## 7. Storage, honestly

`migrations/` holds **two files**: `001_core.sql` (`country_profiles`, `accounts`,
`journal_entries`, `journal_lines`) and `002_admin_users.sql`.

Postgres sinks exist for the ledger, pending settlements, claims, billers,
requests and ops overrides — but the **in-memory store is authoritative at
runtime** and the sinks are write-through with boot hydration. The README's older
line that "storage is in-memory for now" is half-true and half-stale, which is why
§0 says to read the tree.

For a production fiat rail this is the gap to close first: make Postgres the source
of truth rather than a mirror of it.

---

## 8. Testing

```
npm run verify        a dependency-free assertion runner, proves the rail end to end
npm run verify:all    plus async, auth, remit, intl, admin, outbound, requests
npm test              jest --runInBand
npm run demo          narrated two-country walkthrough
npm run typecheck
```

The `verify*` scripts exist so the rail can be proven where `npm install` is
restricted — they need nothing beyond `ts-node`. Jest suites cover exchange,
ledger, markets, money, payroll and rail.

---

## 9. Deployment

`render.yaml` (native Node) and a `Dockerfile`. The demo needs **no database, no
secrets and no MoMo credentials** — mock adapter, in-memory state, resets on
restart. Build `npm install && npm run build`, start `node dist/src/api/server.js`.
