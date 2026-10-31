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
  // Drizzle は失敗クエリをラップし、真の原因（接続失敗など）を `cause` に隠す。
  // 接続系の失敗はここを辿らないと `Failed query: ...` しか出ず原因が分からない。
  console.error(error instanceof Error ? error.message : error);
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause && depth < 5; depth += 1) {
    console.error(`caused by: ${cause instanceof Error ? cause.message : cause}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  process.exitCode = 1;
});