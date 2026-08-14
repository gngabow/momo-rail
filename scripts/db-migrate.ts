/**
 * Run the SQL migrations against DATABASE_URL (idempotent — CREATE TABLE IF NOT
 * EXISTS). Render runs this automatically at boot via PgLedger.init(); this
 * script is for running it by hand.
 *
 *   DATABASE_URL=postgres://… npm run db:migrate
 */
import { PgLedger } from '../src/ledger/pgLedger';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const pg = new PgLedger(url);
  await pg.init();
  console.log('✅ Migrations applied.');
  await pg.close();
}

main().catch((e) => { console.error('Migration failed:', e.message || e); process.exit(1); });
