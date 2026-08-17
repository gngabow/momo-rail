/** Create or reset a DB-backed admin user. Usage:
 *    DATABASE_URL=… ts-node scripts/seed-admin-user.ts <username> <password> [role] */
import { upsertAdmin, close } from '../src/auth/adminStore';
async function main() {
  const [, , username, password, role] = process.argv;
  if (!username || !password) { console.error('Usage: ts-node scripts/seed-admin-user.ts <username> <password> [role]'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  await upsertAdmin(username, password, role || 'super_admin');
  console.log(`created/updated admin "${username}" (role: ${role || 'super_admin'}).`);
  await close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
