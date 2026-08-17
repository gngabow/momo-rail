-- DB-backed admin users (replaces the single ADMIN_PASSWORD env credential).
-- Managed by scripts/seed-admin-user.ts and scripts/set-admin-password.ts,
-- same model as the mpesa-usdt-platform admin.
CREATE TABLE IF NOT EXISTS admin_users (
  id            bigserial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'super_admin',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
