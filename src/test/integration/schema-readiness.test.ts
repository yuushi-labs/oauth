import { describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/client';
import {
  SchemaOutOfDateError,
  assertSchemaReady,
  declaredTableNames,
  findMissingTables,
} from '@/lib/db/schema-readiness';

/**
 * 起動前のスキーマ検査（migration 未適用の検出）。
 *
 * 実 PostgreSQL の `information_schema` を読む。DB を汚さないよう、存在しないテーブルは
 * `ROLLBACK` するトランザクション内で一時的に落として再現する。
 */
describe('Integration - schema readiness（起動前チェック）', () => {
  it('migration 適用済みなら不足なし', async () => {
    expect(await findMissingTables()).toEqual([]);
    await expect(assertSchemaReady()).resolves.toBeUndefined();
  });

  it('宣言テーブルは schema.ts と一致する（24 件）', () => {
    const tables = declaredTableNames();
    expect(tables).toContain('totp');
    expect(tables).toContain('admin_audit_logs');
    expect(tables).toContain('account_deletion_requests');
    expect(tables.length).toBe(24);
  });

  it('テーブルが欠けていれば SchemaOutOfDateError を投げる', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TABLE totp CASCADE');
      expect(await findMissingTables(client)).toContain('totp');

      const error = await assertSchemaReady(client).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SchemaOutOfDateError);
      expect((error as SchemaOutOfDateError).missingTables).toContain('totp');
      expect((error as Error).message).toContain('pnpm db:migrate');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // ROLLBACK 後は元に戻っている。
    expect(await findMissingTables()).toEqual([]);
  });
});
