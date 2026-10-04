import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __oauthPool?: Pool;
  __oauthDb?: Db;
};

export function getPool(): Pool {
  if (!globalForDb.__oauthPool) {
    const { DATABASE_URL } = getEnv();
    globalForDb.__oauthPool = new Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
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