# Handover note — the MoMo rail, and what the KES build learned

**For whoever is building the new fiat project.** Written 9 October 2026 by the
Cowork session that has been on the M-Pesa/KES platform since August. Goes with
`MOMO-RAIL-AS-BUILT-2026-10-09.md`, which is the spec read from the code.

Two things here, and the second is worth more than the first:

1. what the MoMo rail did well enough to copy
2. **what the KES platform learned the expensive way**, which is two months of
   incidents and is the part no greenfield build gets for free

---

## Part 1 — from the MoMo rail: seven things worth taking

**1. The market is a record, not a fork.** `CountryProfile` holds currency, dial
code, phone regex, MSISDN format, provider key, fee schedule, limits, ledger
accounts, feature flags, merchant model, KYC and sanctions providers, and the
licensing position. `railService.ts` names no currency and no operator. Sixteen
markets run through one file; Uganda and Kenya give identical results through it.

If the new build is single-market today, **the shape still pays**: it is the
difference between adding a country and forking a codebase.

**Correcting the count, because the README overstates it.** 15 markets are seeded
and every one is MTN; `grep` for `'KE'` across `src/` returns nothing, so the
README's *"Uganda and Kenya through that same file"* and *"all 16 markets"* are not
true of the tree. Only Uganda is marked `tested: true`.

**2. `require(code)` is not `get(code)`.** One throws `CountryNotFoundError`, the
other `CountryDisabledError`. A market that exists but is switched off is a
different fact from one that was never configured, and the caller is told which.
Small, and it is the kind of distinction that saves an afternoon.

**3. Integer minor units, with the scale as a property of the CURRENCY.**
USDT 6, KES 2, **UGX 0** — the Ugandan shilling has no minor unit at all, which
is the case that breaks anything assuming "cents". Every journal entry balances
exactly because everything is an integer.

**4. One provider seam — and this is the idea the whole thing turns on.**
`collect`, `disburse`, `status`, `handleCallback`. Every operator reached through
four methods, every callback normalised to
`{ reference, providerRef, status, failureReason? }` before settlement code sees
it. Mock → live is a config flip (`MOMO_LIVE_MARKETS=UG,GH`).

**WHAT THIS BUYS, STATED PLAINLY, BECAUSE IT IS EASY TO UNDERSTATE AND EASY TO
OVERSELL.**

*The state:* the plumbing is operator-agnostic; **only MTN's plug has been made.**
Roughly 4,000 of the 4,600 lines — ledger, country records, rail flows,
remittance, exchange, payroll, bill pay — name no operator at all and would be
reused untouched by Vodacom or Airtel. The registry implements two cases, `momo`
and `momo_mock`, and carries a third as a comment:
`// case 'daraja': ... // Kenya parity adapter`.

*The price:* **a day or three of plumbing per operator FAMILY, then free for every
country that family runs in.** You write one file — four methods — and add one
line to the registry. Never a fresh build.

*Where the time actually goes, and it is not the four methods:* each operator has
its own auth scheme, its own payload shapes, its own vocabulary for "pending", and
its own webhook signing. **The hard part is honest translation of STATUS**, and
above all the case where the operator says nothing — the adapter must report *"I
do not know"* rather than *"it failed"*, because reversing on an unknown outcome
refunds a customer whose phone is also being paid. That is a KES incident, and it
is in Part 2.

*One caution worth hearing.* **The seam has had exactly one implementation.** A
seam used once is a hypothesis; the second adapter is what tests it, and it
usually drags one or two assumptions into the open. Budget the second operator
family higher than the third.

*And the limit of "operator-neutral".* The rail assumes money reaches a **phone
number** — an MSISDN, normalised per market by `phoneRegex` and `msisdnFormat`.
That holds across African mobile money. It is **not** how UPI or PIX work, which
are account- and handle-based; those need more than a new adapter.

**5. A 202 is not a settlement.** The operator accepting a request is not the
money moving. The rail records a `PendingSettlement` and settles **exactly once**
on the terminal event; a withdrawal parks funds in a **suspense account** until
the disbursement confirms rather than debiting optimistically.

**6. Remittance as invite / claim / refund.** The recipient does not need an
account first — they redeem by code or MSISDN, and an unclaimed send can be
refunded. That is the actual problem a cross-border rail has.

**7. A dependency-free verification runner.** `npm run verify` proves the rail
end to end with nothing but `ts-node`, so it runs where `npm install` cannot.
Eight of them. Worth having when a build environment fights you.

---

## Part 2 — from the KES platform: what cost us, so it needn't cost you

Every item below is a real incident in a live system. They are in rough order of
how much they cost.

### Money

**Do NOT add a negative-balance guard to a contra account.** This mistake was made
**twice in three batches** and broke a whole rail each time. Some system accounts
are contra: a deposit posts `{float: -X, wallet: +X}`, so the negative balance IS
the customer liability. Guarding the settlement float refuses every payout;
guarding the USDT hot wallet breaks every outbound movement. The test is whether
the balance represents **money the platform holds** (guard it) or **a liability
the platform owes** (never guard it).

**Claim before the money moves.** Three rails — card auth, bill pay, M-Pesa
payouts — each guarded duplicates by SELECTing a row they wrote *afterwards*. A
row that does not exist yet cannot stop anything. The pattern that replaced it:
insert the request row FIRST in a pre-money state, let `UNIQUE(request_reference)`
arbitrate the race, and then **ask the ledger** whether money moved.

**Ask the ledger, never a status column.** The recurring defect shape in this
codebase, in one sentence: *the code reports its intentions as facts.* A value
that gates money was computed from a request parameter or from a status the
application itself wrote. Whether money moved is the one question a claim row
cannot answer about itself.

**An unknown outcome is not a failure.** Reversing a reservation on *every* error
is right for a 4xx and catastrophic for a socket timeout on a payout the operator
is already making — the customer gets their money back while their phone also
gets paid. Indeterminate gets its own state, nothing auto-reverses it, and a
sweeper that cleans up stale rows must SKIP those and raise for review instead.

**Measure claim age on the DATABASE clock**, and measure the attempt's age, not
the row's. One node two minutes ahead of the database is enough to double-charge
platform-wide.

**Do not normalise numbers in an idempotency fingerprint.** An earlier version
did, and `"0012345"` and `"12345"` collided — a retry could pay a different meter.
Leading zeros are load-bearing on meter numbers and paybill references. And a NULL
fingerprint means *unknown*, not *different*: treating it as a mismatch turned
every pre-existing reference into a replay error at the deploy boundary.

**A deposit is identified by (transaction, position within it)** — `tx_hash` plus
`log_index`, never `tx_hash` alone. One transaction can carry several transfers to
the same address. Confirmation depth is per network, and **an unknown network
falls back to 12, never 0**.

### Guards

**An unreachable guard is worse than no guard.** A forced-sale check went in the
natural place, after a status check, where no loan could ever reach it. It would
have shipped looking exactly like protection: a named check, a clear message, a
passing suite, nothing behind it. For any guard protecting money, ask what would
have to be true for control to REACH that line, and write the test that arrives
there.

**A guard nobody throws is a rule nobody enforces.** One error class was declared,
carried a perfect message, and was thrown from nowhere — the fix for a defect where
an interest rate above 100% took money OFF the borrower. 27 of 522 classes were in
that state. A script finds them now.

**A source-reading check must not read its own comments.** A scan window that
includes the explanatory comment above the line it checks will match the WORD and
pass with the LINE deleted — proving the documentation, not the code. Strip
comments first; assert on an assignment, not a mention; guard the end of a path
literal (`/muzzle-check/` matches `/muzzle-checkX`).

### Tests

**A test must be SHOWN to fail.** Not argued to be capable of failing — run
against the broken code, once, deliberately. A check that could not fail was
written here **six times in two days**, by two different workers, no two the same
mistake. Each checked the thing that was easy to count instead of the thing that
mattered: row counts instead of provider calls; field-list equality where the
parser returned an empty list and compared it to an empty list; a fixture amount
that divided evenly so there was never a remainder to spill.

**Any test that scans, parses or globs needs a FLOOR assertion** — that it found
something at all. Zero compared against zero is the most convincing green in a
codebase and it means the test is switched off.

**A test never asserts a number it did not itself create.** Not a magnitude, a
position, a count or a row total that some other suite, seed or environment
produced. Assert a number you inserted, a RELATIONSHIP that holds whatever the
starting state, or a floor.

**A fixture never deletes a table, and never leaves a row in shared reference
data.** Suites in one worker share a database. Deleting other suites' rows went
red on CI while green locally; *inserting* a row was quieter and worse — a funded
liquidity route left behind made a neighbouring suite's "this must be refused"
case succeed. A green where the product was wrong is the failure that matters.

**A unit fixture that writes the row the product cannot write hides a deadlock.**
No marketplace sale could complete through the API for weeks. Every test began by
setting `buyer_customer_id` with direct SQL — a reasonable fixture, and the
product had no path to that state at all. At least one test per flow should reach
its state the way a person does, over HTTP, with nothing set by hand.

### The host

**A test whose expectation depends on anything the HOST provides will pass where
it was written and tell you nothing about the machine that ships.** This family
cost us nine separate failures:

- a path separator inside an expectation (`src\x.ts` on Windows, `src/x.ts` in CI)
- `now()` in SQL compared against a JavaScript `Date` — two clocks, agreeing on
  one machine and not another
- a Docker image that copies `src` and `scripts` and **not `tests`**, so a script
  importing a test helper compiled everywhere a human looked and failed inside the
  image, taking three services down together
- `execFileSync('npx', ...)` — `npx` does not resolve on Windows, and the empty
  stdout is indistinguishable from the check having run and found nothing
- a test listing seven of nine required environment variables, green only because
  the dev machine had a gitignored `.env` with the other two

**The fix that generalises**: run the suite the way CI runs it before you believe
it. Ours hides `.env`, passes only `DATABASE_URL` and `NODE_ENV=test`, and runs
serial. It exists because the only host that disagreed was the one that ships.

### Keeping the record

**"Done" means three things — say which.** RULED (decided and in the spec), BUILT
(the server does it, with tests), REACHABLE (a person can get to it from a screen).
Five features here were marked done and reached nobody — the server was right and
had been right for weeks. **A green suite is not a door.**

**Before reporting a finding, ask the register.** Three findings in two days were
reported as gaps that the decision log had already settled. The code says what the
system DOES; it cannot say *"we looked at this and decided it is fine"*. That
sentence lives only in the register, so finished work reads as unfinished and
somebody spends their attention re-closing it.

**Never quote a count — derive it, and name what you read.** Four different
figures for the same thing reached the product owner in one afternoon.

---

## What NOT to copy from the MoMo rail

**Its storage.** Postgres sinks exist, but the in-memory store is authoritative at
runtime and the sinks mirror it. For a production fiat rail, make Postgres the
source of truth first. Two migrations is a sketch, not a schema.

**Its README.** It grew by accretion, has struck-through items, and contradicts
itself on whether storage is in-memory. Read the tree.

**Its test depth.** Six Jest suites and eight verify scripts prove the thesis;
they do not prove a money system. The KES build runs 618 suites and 5,335 tests
against a real database with nothing mocked at the persistence layer — deliberately,
and it is why the suite is slow and trustworthy.

---

## If you read one thing

The MoMo rail's best idea is that **a market is a row**. The KES platform's best
lesson is that **the ledger is the only thing that knows whether money moved** —
not a status column, not a response code, not the function that just tried.

A build that has both is ahead of where either of these started.
