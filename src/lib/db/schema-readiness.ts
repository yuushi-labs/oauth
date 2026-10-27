import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { getPool } from './client';
import * as schema from './schema';

/** Drizzle の schema に宣言された全テーブル名（`public` スキーマ）。 */
export function declaredTableNames(): string[] {
  return Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((value) => getTableName(value as PgTable))
    .sort();
}

/**
 * migration 未適用（DB がコードより古い）を起動時に検出する。
 *
 * 未適用のまま起動すると、最初にそのテーブルを参照したリクエストが
 * `relation "xxx" does not exist`（42P01）で 500 になる。原因が分かりにくいため、
 * 不足テーブルを列挙して `pnpm db:migrate` を案内するメッセージを返す。
 */
export class SchemaOutOfDateError extends Error {
  constructor(readonly missingTables: string[]) {
    super(
      `データベースのスキーマがコードより古いです。未適用のテーブル: ${missingTables.join(', ')}。` +
        '`pnpm db:migrate`（必要なら続けて `pnpm seed`）を実行してから起動してください。',
    );
    this.name = 'SchemaOutOfDateError';
  }
}

/** `information_schema.tables` を問い合わせられる最小の実行者（Pool / トランザクション client）。 */
type TableQuery = { query(sql: string): Promise<{ rows: { table_name: string }[] }> };

/** 宣言されたテーブルのうち、実 DB に存在しないものを返す（存在すれば空配列）。 */
export async function findMissingTables(executor: TableQuery = getPool()): Promise<string[]> {
  const declared = declaredTableNames();
  if (declared.length === 0) return [];
  const { rows } = await executor.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const present = new Set(rows.map((row) => row.table_name));
  return declared.filter((name) => !present.has(name));
}

/** 不足があれば `SchemaOutOfDateError` を投げる。起動前チェックに使う。 */
export async function assertSchemaReady(executor: TableQuery = getPool()): Promise<void> {
  const missing = await findMissingTables(executor);
  if (missing.length > 0) throw new SchemaOutOfDateError(missing);
}
