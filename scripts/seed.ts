import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getPool } from '../src/lib/db/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ROLE_SEED, roles } from '../src/lib/db/schema';

async function main(): Promise<void> {
  const pool = getPool();
  const db = drizzle(pool, { schema: { roles } });

  await db
    .insert(roles)
    .values(ROLE_SEED.map((role) => ({ ...role })))
    .onConflictDoUpdate({
      target: roles.id,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
      },
    });

  console.log(`seeded roles: ${ROLE_SEED.map((role) => role.id).join(', ')}`);
  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});