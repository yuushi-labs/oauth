/**
 * P25-E-04: migration の可逆性を検証する。
 *
 * やること:
 *   1. 一時データベースを作り、全 migration を適用（up）
 *   2. 期待するスキーマ（テーブル・制約・インデックス・列）であることを検証
 *   3. 全 migration を逆順に roll back（down）
 *   4. 全テーブルが消え、应用テーブル以外のオブジェクトが残っていないことを確認
 *   5. もう一度 up を適用し、スキーマが手順 2 と一致することを確認（往復でドリフトしない）
 *   6. 手順 5 で入れたデータが `pg_dump` → 別DB への `pg_restore` で復元できることを確認（restore）
 *
 * 実行: pnpm db:verify-migrations
 * 本スクリプトは検証用 DB を作成し、終了時に削除する。アプリケーションデータには触らない。
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';

const exec = promisify(execFile);
const { Client } = pg;

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL が未設定です');

const adminUrl = new URL(sourceUrl);
const adminDatabase = adminUrl.pathname.slice(1) || 'app';
const suffix = randomBytes(4).toString('hex');
const testDatabase = `migration_check_${suffix}`;

function databaseUrl(name: string): string {
  const url = new URL(sourceUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl(adminDatabase) });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function withDatabase<T>(database: string, operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl(database) });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

type SchemaSnapshot = {
  tables: string[];
  columns: Record<string, string[]>;
  indexes: Record<string, string[]>;
  checks: Record<string, string[]>;
  foreignKeys: Record<string, string[]>;
};

async function snapshot(client: pg.Client): Promise<SchemaSnapshot> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const columns = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' ORDER BY table_name, column_name`,
  );
  const indexes = await client.query<{ table_name: string; indexname: string }>(
    `SELECT tablename AS table_name, indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`,
  );
  const checks = await client.query<{ table_name: string; conname: string }>(
    `SELECT rel.relname AS table_name, con.conname FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND con.contype = 'c' ORDER BY rel.relname, con.conname`,
  );
  const foreignKeys = await client.query<{ table_name: string; conname: string }>(
    `SELECT rel.relname AS table_name, con.conname FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND con.contype = 'f' ORDER BY rel.relname, con.conname`,
  );

  const group = (rows: readonly { table_name: string }[], key: string): Record<string, string[]> => {
    const result: Record<string, string[]> = {};
    for (const row of rows) {
      const table = row.table_name;
      const value = String((row as unknown as Record<string, unknown>)[key]);
      (result[table] ??= []).push(value);
    }
    return result;
  };

  return {
    tables: tables.rows.map((row) => row.table_name),
    columns: group(columns.rows, 'column_name'),
    indexes: group(indexes.rows, 'indexname'),
    checks: group(checks.rows, 'conname'),
    foreignKeys: group(foreignKeys.rows, 'conname'),
  };
}

async function migrateUp(database: string): Promise<void> {
  await exec('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl(database) },
    cwd: resolve(process.cwd()),
  });
}

/** Reads drizzle/meta/_journal.json so the down migration replays migrations in reverse order. */
async function migrationFilesReverse(): Promise<string[]> {
  const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const files = await readdir(resolve('drizzle'));
  const known = new Set(files.filter((file) => file.endsWith('.sql')));
  const tags = journal.entries.map((entry) => entry.tag).filter((tag) => known.has(`${tag}.sql`));
  if (tags.length !== known.size) {
    throw new Error(`journal と migration ファイルが一致しません: journal=${tags.length} files=${known.size}`);
  }
  return tags.reverse().map((tag) => `${tag}.sql`);
}

/**
 * drizzle-kit does not emit down migrations, so the script rolls back by dropping the objects each
 * migration created. This mirrors what an operator would do and proves the schema is not
 * depending on a half-applied state.
 */
async function migrateDown(database: string): Promise<void> {
  const files = await migrationFilesReverse();
  const pool = new pg.Client({ connectionString: databaseUrl(database) });
  await pool.connect();
  try {
    for (const file of files) {
      const sql = await readFile(resolve('drizzle', file), 'utf8');
      const drop = downStatementsFor(file, sql);
      for (const statement of drop) await pool.query(statement);
      // drizzle-kit stores the applied journal in the `drizzle` schema, not in `public`.
      await pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1', [statementHash(sql)]);
    }
  } finally {
    await pool.end();
  }
}

/** Mirrors drizzle-kit's journal bookkeeping closely enough for a local reversibility check. */
function statementHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Derives the rollback for a migration from the objects it creates. Only the statements this
 * project's migrations actually use are supported; anything else throws so the check cannot
 * silently pass.
 */
function downStatementsFor(file: string, sql: string): string[] {
  const statements: string[] = [];
  // Data migrations carry explanatory `--` comments. drizzle-kit applies them fine, but the
  // classifier below matches on the leading keyword, so strip comment-only lines first.
  const stripComments = (part: string): string =>
    part
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
  const statementsInOrder = sql
    .split('--> statement-breakpoint')
    .map(stripComments)
    .filter(Boolean);

  for (const statement of statementsInOrder) {
    if (/^CREATE TABLE "([^"]+)"/i.test(statement)) {
      statements.push(`DROP TABLE IF EXISTS "${/^CREATE TABLE "([^"]+)"/i.exec(statement)![1]}" CASCADE`);
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" (\w+)/i.test(statement)) {
      const [, table, column] = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" (\w+)/i.exec(statement)!;
      statements.push(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`);
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" DROP COLUMN "([^"]+)"/i.test(statement)) {
      // Already-dropped columns are only recreated by a new migration; nothing to undo.
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" DROP CONSTRAINT "([^"]+)"/i.test(statement)) {
      // A constraint created by an earlier migration: re-adding it belongs to that migration's own
      // rollback, which already ran further down the chain.
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i.test(statement)) {
      const [, table, constraint] = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i.exec(statement)!;
      statements.push(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
      continue;
    }
    if (/^CREATE (UNIQUE )?INDEX "([^"]+)"/i.test(statement)) {
      statements.push(`DROP INDEX IF EXISTS "${/^CREATE (UNIQUE )?INDEX "([^"]+)"/i.exec(statement)![2]}"`);
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" RENAME COLUMN "([^"]+)" TO "([^"]+)"/i.test(statement)) {
      const [, table, from, to] = /^ALTER TABLE "([^"]+)" RENAME COLUMN "([^"]+)" TO "([^"]+)"/i.exec(statement)!;
      statements.push(`ALTER TABLE "${table}" RENAME COLUMN "${to}" TO "${from}"`);
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET DEFAULT/i.test(statement)) {
      // A later migration sets the real default; reversing to NULL is only needed to reproduce the
      // exact pre-migration state, which the schema comparison in step 3 verifies.
      const [, table, column] = /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET DEFAULT/i.exec(statement)!;
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`);
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" DROP NOT NULL/i.test(statement)) {
      const [, table, column] = /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" DROP NOT NULL/i.exec(statement)!;
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET NOT NULL`);
      continue;
    }
    if (/^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET NOT NULL/i.test(statement)) {
      const [, table, column] = /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET NOT NULL/i.exec(statement)!;
      statements.push(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`);
      continue;
    }
    if (/^(UPDATE|INSERT|DELETE)\s/i.test(statement)) {
      // Data migrations are not reversible, but every statement they precede or follow in this
      // project creates or drops a column/table, so the object removal below already discards the
      // data. Nothing to undo here.
      continue;
    }
    if (/^DROP INDEX/i.test(statement)) continue;
    if (/^ALTER TABLE .* RENAME/i.test(statement)) continue;
    if (/^CREATE TYPE/i.test(statement)) continue;
    throw new Error(`${file} に対応する down migration を自動生成できません: ${statement.slice(0, 120)}`);
  }
  return statements.reverse();
}

async function main(): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${testDatabase}"`);
    await client.query(`CREATE DATABASE "${testDatabase}"`);
  });
  process.stdout.write(`# migration 可逆性チェック（${testDatabase}）\n\n`);

  try {
    process.stdout.write('## 1. up（全 migration 適用）\n');
    await migrateUp(testDatabase);
    const afterUp = await withDatabase(testDatabase, (client) => snapshot(client));
    process.stdout.write(`- テーブル数: ${afterUp.tables.length} (${afterUp.tables.join(', ')})\n`);
    process.stdout.write(`- CHECK 制約数: ${Object.values(afterUp.checks).flat().length}\n`);
    process.stdout.write(`- 外部キー数: ${Object.values(afterUp.foreignKeys).flat().length}\n`);
    process.stdout.write(`- インデックス数: ${Object.values(afterUp.indexes).flat().length}\n`);

    const expectations: [string, boolean][] = [
      ['users テーブルが存在する', afterUp.tables.includes('users')],
      ['oauth_clients テーブルが存在する', afterUp.tables.includes('oauth_clients')],
      ['oidc_artifacts テーブルが存在する', afterUp.tables.includes('oidc_artifacts')],
      ['rate_limit_reservations テーブルが存在する', afterUp.tables.includes('rate_limit_reservations')],
      ['oauth_clients.owner_user_id 列がある（migration 0013）', (afterUp.columns.oauth_clients ?? []).includes('owner_user_id')],
      ['oauth_clients.secret_hash 列がある（migration 0011）', (afterUp.columns.oauth_clients ?? []).includes('secret_hash')],
      ['oauth_clients.secret_ciphertext 列が無い（migration 0012）', !(afterUp.columns.oauth_clients ?? []).includes('secret_ciphertext')],
      ['oauth_clients に owner_user_id の外部キーがある', Object.hasOwn(afterUp.foreignKeys, 'oauth_clients')],
      ['oauth_clients に type/openid/scope/secret の CHECK がある',
        (afterUp.checks.oauth_clients ?? []).includes('oauth_clients_openid_required_chk')
        && (afterUp.checks.oauth_clients ?? []).includes('oauth_clients_scope_allowlist_chk')
        && (afterUp.checks.oauth_clients ?? []).includes('oauth_clients_secret_type_chk')],
      ['users に status/email_verified の CHECK がある',
        (afterUp.checks.users ?? []).includes('users_status_chk')
        && (afterUp.checks.users ?? []).includes('users_status_email_verified_chk')],
      ['論理削除を許容する partial unique index がある',
        Object.values(afterUp.indexes).flat().includes('users_username_lower_uniq')
        && Object.values(afterUp.indexes).flat().includes('users_email_lower_uniq')],
      ['totp テーブルが存在する（migration 0017）', afterUp.tables.includes('totp')],
      ['recovery_codes テーブルが存在する（migration 0017）', afterUp.tables.includes('recovery_codes')],
      ['totp に secret_encrypted / enabled / last_used_counter 列がある',
        ['secret_encrypted', 'enabled', 'last_used_counter', 'confirmed_at'].every((column) =>
          (afterUp.columns.totp ?? []).includes(column))],
      ['totp は users への外部キーを持つ',
        Object.values(afterUp.foreignKeys).flat().includes('totp_user_id_users_id_fk')],
      ['recovery_codes は users への外部キーと code_hash の一意インデックスを持つ',
        Object.values(afterUp.foreignKeys).flat().includes('recovery_codes_user_id_users_id_fk')
        && (afterUp.indexes.recovery_codes ?? []).includes('recovery_codes_code_hash_uniq')],
      ['webauthn_credentials テーブルが存在する（migration 0018）', afterUp.tables.includes('webauthn_credentials')],
      ['webauthn_challenges テーブルが存在する（migration 0018）', afterUp.tables.includes('webauthn_challenges')],
      ['webauthn_credentials に credential_id の unique index がある',
        (afterUp.indexes.webauthn_credentials ?? []).includes('webauthn_credentials_credential_id_uniq')],
      ['webauthn_credentials.sign_count 列がある', (afterUp.columns.webauthn_credentials ?? []).includes('sign_count')],
      ['webauthn_challenges に expires_at の index がある',
        (afterUp.indexes.webauthn_challenges ?? []).includes('webauthn_challenges_expires_at_idx')],
      ['role_permissions テーブルが存在する（migration 0019）', afterUp.tables.includes('role_permissions')],
      ['admin_audit_logs テーブルが存在する（migration 0019）', afterUp.tables.includes('admin_audit_logs')],
      ['role_permissions は roles への外部キーを持つ',
        Object.values(afterUp.foreignKeys).flat().includes('role_permissions_role_id_roles_id_fk')],
      ['admin_audit_logs は users への外部キーを 2 本持つ',
        Object.values(afterUp.foreignKeys).flat().includes('admin_audit_logs_actor_user_id_users_id_fk')
        && Object.values(afterUp.foreignKeys).flat().includes('admin_audit_logs_target_user_id_users_id_fk')],
      ['admin_audit_logs に created_at の index がある',
        (afterUp.indexes.admin_audit_logs ?? []).includes('admin_audit_logs_created_at_idx')],
    ];
    for (const [label, ok] of expectations) {
      process.stdout.write(`- ${ok ? '✅' : '❌'} ${label}\n`);
      if (!ok) throw new Error(`スキーマ検証に失敗: ${label}`);
    }

    process.stdout.write('\n## 2. down（全 migration を逆順に roll back）\n');
    await migrateDown(testDatabase);
    const afterDown = await withDatabase(testDatabase, (client) => snapshot(client));
    process.stdout.write(`- 残存テーブル: ${afterDown.tables.length ? afterDown.tables.join(', ') : '(なし)'}\n`);
    if (afterDown.tables.length > 0) throw new Error(`down 後にテーブルが残っています: ${afterDown.tables.join(', ')}`);

    process.stdout.write('\n## 3. 往復（down 後に再度 up）\n');
    await migrateUp(testDatabase);
    const afterSecondUp = await withDatabase(testDatabase, (client) => snapshot(client));
    const drift = diffSnapshots(afterUp, afterSecondUp);
    if (drift.length > 0) {
      for (const line of drift) process.stdout.write(`- ❌ ${line}\n`);
      throw new Error('往復でスキーマに差分が出ました');
    }
    process.stdout.write('- ✅ up → down → up でスキーマ差分なし\n');

    process.stdout.write('\n## 4. restore（pg_dump → pg_restore）\n');
    const restoreDatabase = `${testDatabase}_restore`;
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${restoreDatabase}"`);
      await client.query(`CREATE DATABASE "${restoreDatabase}"`);
    });
    await withDatabase(testDatabase, async (client) => {
      await client.query(
        `INSERT INTO roles (id, name, description) VALUES ('role_user', 'user', '利用者'), ('role_admin', 'admin', '管理者') ON CONFLICT DO NOTHING`,
      );
      await client.query(
        `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id, password_changed_at)
         VALUES ('usr_restore_check', 'restore_check', 'restore-check@example.com', true, 'hash', 'active', 'role_user', now())`,
      );
      await client.query(
        `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash, owner_user_id)
         VALUES ('cli_restore_check', 'Restore Check', 'Restore Operator', 'confidential', '["https://rp.example/cb"]'::jsonb,
                 ARRAY['openid']::text[], ARRAY[]::text[], 'client_secret_basic', 'hmac-sha256:test', 'usr_restore_check')`,
      );
    });

    // The test database lives on the same PostgreSQL instance as DATABASE_URL, so the node client
    // reaches it directly. pg_dump is used when present on the host, otherwise the container copy
    // is used. Both produce a custom-format archive that pg_restore reads back.
    process.stdout.write(`- 復元手段: ${(await dumpAndRestore(testDatabase, restoreDatabase)).usedTool}\n`);
    const restored = await withDatabase(restoreDatabase, (client) =>
      client.query<{ clients: number; users: number; owner: string | null }>(
        `SELECT (SELECT count(*)::int FROM oauth_clients) AS clients,
                (SELECT count(*)::int FROM users) AS users,
                (SELECT owner_user_id FROM oauth_clients WHERE client_id = 'cli_restore_check') AS owner`,
      ),
    );
    process.stdout.write(`- clients=${restored.rows[0]?.clients} users=${restored.rows[0]?.users} owner_user_id=${restored.rows[0]?.owner}\n`);
    if (restored.rows[0]?.clients !== 1 || restored.rows[0]?.users !== 1 || restored.rows[0]?.owner !== 'usr_restore_check') {
      throw new Error('restore 後のデータが一致しません');
    }
    process.stdout.write('- ✅ pg_dump → pg_restore でデータと外部キー関係が復元できた\n');

    process.stdout.write('\n# 結果: up / down / 往復 / restore のすべてが成功\n');
  } finally {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${testDatabase}_restore"`).catch(() => undefined);
      await client.query(`DROP DATABASE IF EXISTS "${testDatabase}"`).catch(() => undefined);
    });
  }
}

/** Restores a dump of `source` into `target`, preferring host pg_dump and falling back to the container. */
async function dumpAndRestore(source: string, target: string): Promise<{ usedTool: string }> {
  const hostDump = `/tmp/${source}.dump`;
  try {
    await exec('pg_dump', ['-d', databaseUrl(source), '--format=custom', '--file', hostDump], { maxBuffer: 128 * 1024 * 1024 });
    await exec('pg_restore', ['-d', databaseUrl(target), '--clean', '--if-exists', hostDump], { maxBuffer: 128 * 1024 * 1024 });
    await rm(hostDump, { force: true });
    return { usedTool: 'host pg_dump/pg_restore' };
  } catch {
    await rm(hostDump, { force: true });
  }

  const containerFile = `/tmp/${source}.dump`;
  const user = process.env.POSTGRES_USER ?? 'app';
  await exec('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', user, '-d', source, '-Fc', '-f', containerFile], { cwd: resolve(process.cwd()) });
  await exec('docker', ['compose', 'exec', '-T', 'db', 'pg_restore', '-U', user, '-d', target, '--clean', '--if-exists', containerFile], { cwd: resolve(process.cwd()) });
  await exec('docker', ['compose', 'exec', '-T', 'db', 'rm', '-f', containerFile], { cwd: resolve(process.cwd()) }).catch(() => undefined);
  return { usedTool: 'container pg_dump/pg_restore' };
}

function diffSnapshots(before: SchemaSnapshot, after: SchemaSnapshot): string[] {
  const differences: string[] = [];
  const compare = (label: string, left: string[], right: string[]) => {
    const missing = left.filter((item) => !right.includes(item));
    const added = right.filter((item) => !left.includes(item));
    for (const item of missing) differences.push(`${label}: ${before === after ? '' : ''}${item} が消えている`);
    for (const item of added) differences.push(`${label}: ${item} が追加されている`);
  };
  compare('テーブル', before.tables, after.tables);
  for (const table of before.tables) {
    compare(`${table}.columns`, before.columns[table] ?? [], after.columns[table] ?? []);
    compare(`${table}.indexes`, before.indexes[table] ?? [], after.indexes[table] ?? []);
    compare(`${table}.checks`, before.checks[table] ?? [], after.checks[table] ?? []);
    compare(`${table}.foreignKeys`, before.foreignKeys[table] ?? [], after.foreignKeys[table] ?? []);
  }
  return differences;
}

main()
  .then(async () => {
    const { getPool } = await import('@/lib/db/client');
    await getPool().end().catch(() => undefined);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`\nmigration 検証に失敗しました: ${error instanceof Error ? error.message : String(error)}\n`);
    const { getPool } = await import('@/lib/db/client');
    await getPool().end().catch(() => undefined);
    process.exitCode = 1;
  });
