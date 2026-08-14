-- One-In-All Rail — core schema (production Postgres path).
-- The in-memory Ledger in src/ledger/ledger.ts implements exactly this model;
-- swapping to Postgres is implementing the same methods over these tables.

-- Every market's config as data — hot-editable from the ops console.
CREATE TABLE IF NOT EXISTS country_profiles (
  code                       text PRIMARY KEY,          -- ISO-3166-1 alpha-2
  display_name               text NOT NULL,
  enabled                    boolean NOT NULL DEFAULT false,
  local_currency             text NOT NULL,
  dial_code                  text NOT NULL,
  phone_regex                text NOT NULL,
  msisdn_format              text NOT NULL DEFAULT 'bare',
  momo_operator              text NOT NULL,
  provider_key               text NOT NULL,             -- 'momo' | 'daraja' | 'momo_mock'
  provider_env               text NOT NULL DEFAULT 'sandbox',
  fee_schedule               jsonb NOT NULL,            -- { convertRate, remittanceRate, merchantPayRate }
  limits                     jsonb NOT NULL,
  ledger_accounts            jsonb NOT NULL,            -- { localFloatId, localFeeRevenueId, usdtHotWalletId, usdtFeeRevenueId }
  features                   jsonb NOT NULL,
  merchant_model             text NOT NULL DEFAULT 'none',
  kyc_provider_key           text NOT NULL,
  sanctions_provider_key     text NOT NULL,
  screening                  jsonb NOT NULL,
  licensing                  jsonb NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Currency-agnostic accounts. country_code is NULL for shared/cross-market
-- system accounts (e.g. the USDT hot wallet).
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NULL,
  currency      text NOT NULL,
  account_type  text NOT NULL,
  country_code  text NULL REFERENCES country_profiles(code),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_customer_currency_type
  ON accounts (customer_id, currency, account_type) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts (country_code);

-- Double-entry journal. Every entry balances to zero per currency (enforced in
-- app code). Amounts stored as integer minor units for exactness.
CREATE TABLE IF NOT EXISTS journal_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type       text NOT NULL,
  idempotency_key  text NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id            bigserial PRIMARY KEY,
  entry_id      uuid NOT NULL REFERENCES journal_entries(id),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  currency      text NOT NULL,
  amount_minor  bigint NOT NULL   -- signed; per-currency sum across an entry must be 0
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines (entry_id);
