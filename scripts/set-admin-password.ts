/** Change an existing admin user's password. Usage:
 *    DATABASE_URL=… ts-node scripts/set-admin-password.ts <username> <password> */
import { setPassword, close } from '../src/auth/adminStore';
async function main() {
  const [, , username, password] = process.argv;
  if (!username || !password) { console.error('Usage: ts-node scripts/set-admin-password.ts <username> <password>'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const okd = await setPassword(username, password);
  console.log(okd ? `Password updated for "${username}".` : `No admin user "${username}" found.`);
  await close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
