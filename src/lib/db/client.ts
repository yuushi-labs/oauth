import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from '@/lib/env';
import { resolveDatabaseSsl } from './ssl';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __oauthPool?: Pool;
  __oauthDb?: Db;
};

export function getPool(): Pool {
  if (!globalForDb.__oauthPool) {
    const { DATABASE_URL, DATABASE_SSL_MODE } = getEnv();
    globalForDb.__oauthPool = new Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: resolveDatabaseSsl(DATABASE_SSL_MODE),
    });
  }
  return globalForDb.__oauthPool;
}

export function getDb(): Db {
  if (!globalForDb.__oauthDb) {
    globalForDb.__oauthDb = drizzle(getPool(), { schema });
  }
  return globalForDb.__oauthDb;
}

export type DbClient = Db;
export { schema };