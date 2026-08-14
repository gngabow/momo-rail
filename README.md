# One-In-All Rail — MoMo ⇄ USDT (standalone)

A **country-configurable** MTN MoMo ⇄ USDT rail for Africa. One codebase, one
deployment, every market as a `CountryProfile` — not a fork. This is a fresh,
greenfield project, **entirely separate** from the M-Pesa/KES build.

> **Phase 0→1 scaffold.** The core is real and tested: a currency-agnostic
> double-entry ledger, the `CountryProfile` registry, the `MobileMoneyProvider`
> abstraction (mock + real MTN MoMo skeleton), and country-driven
> deposit → convert → withdraw flows. Proven on two markets (Uganda/UGX and
> Kenya/KES) through **one** code path. Storage is in-memory for now; the
> Postgres schema is sketched in `migrations/001_core.sql`.

## Run it

```bash
npm install          # in a normal environment (installs jest/ts-node/typescript)
npm run verify       # dependency-free assertion runner — proves the rail end-to-end
npm run demo         # narrated two-country walkthrough
npm test             # the Jest suite (same intent as verify)
npm run typecheck    # tsc --noEmit
```

`npm run verify` and `npm run demo` use `ts-node` and need no packages beyond it,
so they run even where `npm install` is restricted.

## What proves the thesis

`src/rail/railService.ts` is the whole point: it never mentions KES, UGX, or an
operator. It resolves the requested market's `CountryProfile` and reads currency,
provider, fees, and compliance from it. The demo and tests run **Uganda and
Kenya on that same file** — 380,000 UGX and 12,900 KES both convert to exactly
98.5 USDT after the 1.5% fee, through identical code.

## Architecture

```
Product flows      rail/railService.ts  (deposit · convert · withdraw)
Domain             exchange/ · compliance/ · wallet/ · fx/
Rail abstraction   providers/mobileMoneyProvider.ts
                     ├─ mockMoMoClient.ts   (tests & pre-credential dev)
                     └─ momoClient.ts       (real MTN Open API skeleton)
Ledger             ledger/ledger.ts + money.ts  (currency-agnostic, minor-unit exact)
Config             config/countryProfile.ts     (the per-market record + registry)
```

Money is stored in **integer minor units** per currency (USDT=6, KES=2, UGX=0 —
the Ugandan shilling has no minor unit) so every journal entry balances exactly.

## Adding a country

1. Add a `CountryProfile` (see `src/config/countryProfile.ts` → `seedProfiles`).
2. Point `providerKey` at an adapter (`momo` for a live MTN OpCo, `momo_mock`
   for dev). Supply the OpCo's MoMo credentials via `providerConfigRef`.
3. Seed the market's system ledger accounts (float, fee-revenue) — see
   `config/bootstrap.ts`.
4. Set `features.*` and `licensing.vaspLicensed` to gate what's legally live.

No business logic changes. That is the design.

## Mapping to MTN MoMo Open API

| Rail verb | MoMo Open API |
|---|---|
| `collect` (deposit) | Collections → `requesttopay` |
| `disburse` (payout / payroll) | Disbursements → `transfer` |
| `status` | `GET …/{X-Reference-Id}` |
| callbacks | normalized via `handleCallback` |

One `MoMoClient` is parameterised per operating company; the API spec is common
across MTN's markets, only credentials/target-environment differ.

## Not yet built (next phases)

- Postgres-backed ledger + `CountryProfile` store (schema sketched in `migrations/`).
- Real MoMo integration against a sandbox OpCo (replace `momo_mock`).
- Product breadth: inbound/outbound remittance, MoMoPay, agents — country-flagged.
  (**Payroll via MoMo Disbursements is already built** — `src/payroll/payrollService.ts`,
  bulk payout from an employer's local wallet to many workers' MoMo, tested.)
- Per-market liquidity/treasury + FX feeds; ops console with a market switcher.
- Auth/OTP and production hardening.

## The portal + API

A **zero-dependency** HTTP server (`src/api/server.ts`, Node's built-in `http`)
puts the tested rail behind a small JSON API and serves the wallet portal
(`web/index.html`). It's a live, clickable demo of the real engine — mock MoMo
adapter, in-memory state (resets on restart), no external services.

```bash
npm install
npm run serve                 # ts-node → http://localhost:3000
# or a compiled run:
npm run build && npm start    # → dist/src/api/server.js
```

Open `http://localhost:3000`: switch across all 16 markets and do cash-in →
convert → cash-out → payroll, plus an Ops · Markets view. Endpoints:
`GET /api/markets`, `GET /api/wallet`, `POST /api/deposit|convert|withdraw|payroll`,
`GET /api/activity`, `GET /health`.

## Deploy (Render — like the M-PESA rail)

`render.yaml` (native Node) and a `Dockerfile` are included. No database, no
secrets, no MoMo credentials needed for the demo.

1. Push this project to a **new GitHub repo**.
2. Render → **New → Blueprint** → pick the repo → it reads `render.yaml` → **Apply**.
   (Or New → Web Service → Node; build `npm install && npm run build`; start `node dist/src/api/server.js`.)
3. It goes live at `https://<name>.onrender.com`. For a subdomain like
   `momo.airtimepap.com`: add it as a **Custom Domain** on the Render service, then
   add the **CNAME** it shows you at your DNS (GoDaddy) — exactly how the M-PESA rail
   was pointed at `usdt-mpesa.airtimepap.com`.

Free tier sleeps after ~15 min idle (first hit wakes it in a few seconds).

See `../momo-rail-blueprint.md` for the full architecture and market-sequencing view.
