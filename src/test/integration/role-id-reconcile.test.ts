import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * migration 0023（旧 role id の統合）の回帰テスト。
 *
 * 旧デプロイから引き継いだ DB に「同じ name・別 id」の role 行（例: `id='user'`）が
 * 残っていると、`roles.name` の UNIQUE 制約により `pnpm seed`（`ON CONFLICT (id)`）が
 * `roles_name_unique` 違反で失敗する。0023 はこの行を正規 id へ寄せてから制約を張り直す。
 *
 * 実際の migration SQL を 0022 まで適用 → 旧行を投入 → 0023 を適用、という順で
 * 実 PostgreSQL に対して検証する。
 */

const run = promisify(execFile);
const TEST_DB = 'oauth_role_reconcile';
const RECONCILE = '0023_role_id_reconcile.sql';

function databaseUrl(dbName: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required for this test');
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** `createdb` / `dropdb` に渡す接続引数（`-w` で対話待ちを禁止する）。 */
function adminArgs(): string[] {
  const url = new URL(process.env.DATABASE_URL ?? '');
  return ['-w', '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
}

async function psql(dbName: string, args: string[]): Promise<string> {
  const { stdout } = await run('psql', ['-w', '--no-align', '--tuples-only', '--dbname', databaseUrl(dbName), ...args]);
  return stdout.trim();
}

async function applyMigration(dbName: string, file: string): Promise<void> {
  const sql = await readFile(resolve('drizzle', file), 'utf8');
  await run('psql', ['-w', '-v', 'ON_ERROR_STOP=1', '--dbname', databaseUrl(dbName), '-f', resolve('drizzle', file)], {
    env: { ...process.env, PGPASSWORD: new URL(databaseUrl(dbName)).password },
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`migration ${file} の適用に失敗しました: ${detail}\n${sql.slice(0, 200)}`);
  });
}

async function migrationFilesBefore(target: string): Promise<string[]> {
  const files = (await readdir(resolve('drizzle'))).filter((file) => file.endsWith('.sql'));
  return files.filter((file) => file < target).sort();
}

beforeAll(async () => {
  // 子プロセスの psql が非対話で認証できるよう、DB パスワードを環境へ載せる。
  const url = new URL(process.env.DATABASE_URL ?? '');
  process.env.PGPASSWORD = decodeURIComponent(url.password);
  await run('dropdb', ['--if-exists', '--force', ...adminArgs(), TEST_DB]).catch(() => undefined);
  await run('createdb', [...adminArgs(), TEST_DB]);

  for (const file of await migrationFilesBefore(RECONCILE)) await applyMigration(TEST_DB, file);
});

afterAll(async () => {
  await run('dropdb', ['--if-exists', '--force', ...adminArgs(), TEST_DB]).catch(() => undefined);
});

describe('Integration - migration 0023（旧 role id の統合）', () => {
  it('旧 id の role 行を正規 id へ寄せ、seed が成功する状態にする', async () => {
    // 0022 時点の DB に、旧デプロイ由来の「name は正規・id は別物」の行と、その id を
    // 参照するユーザー／権限を投入する。
    await psql(TEST_DB, [
      '-c',
      `INSERT INTO roles (id, name, description) VALUES ('user', 'user', '旧'), ('admin', 'admin', '旧')`,
    ]);
    await psql(TEST_DB, [
      '-c',
      `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id)
         VALUES ('usr_legacy', 'legacy', 'legacy@example.com', true, 'hash', 'active', 'user')`,
    ]);
    await psql(TEST_DB, [
      '-c',
      `INSERT INTO role_permissions (role_id, permission) VALUES ('user', 'user.read'), ('admin', 'admin.all')`,
    ]);

    // 旧 id が残ったままだと、seed と同じ `ON CONFLICT (id)` の upsert は name 制約で失敗する。
    const before = await run(
      'psql',
      [
        '-w',
        '-v',
        'ON_ERROR_STOP=1',
        '--dbname',
        databaseUrl(TEST_DB),
        '-c',
        `INSERT INTO roles (id, name, description) VALUES
           ('role_user', 'user', '一般ユーザー'), ('role_moderator', 'moderator', 'モデレーター（将来拡張）'),
           ('role_admin', 'admin', '管理者'), ('role_superadmin', 'superadmin', '最上位管理者（将来拡張）')
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description`,
      ],
    ).then(
      () => 'ok',
      () => 'failed',
    );
    expect(before).toBe('failed');

    // 0023 を適用する。
    await applyMigration(TEST_DB, RECONCILE);

    // 正規 4 行だけが残り、name の UNIQUE 制約が復活している。
    expect(await psql(TEST_DB, ['-c', 'SELECT id FROM roles ORDER BY id'])).toBe(
      ['role_admin', 'role_moderator', 'role_superadmin', 'role_user'].join('\n'),
    );
    expect(
      await psql(TEST_DB, [
        '-c',
        `SELECT conname FROM pg_constraint WHERE conrelid = 'roles'::regclass AND contype = 'u'`,
      ]),
    ).toBe('roles_name_unique');

    // 依存データが正規 id へ付け替わっている（旧 id を参照する行は残らない）。
    expect(await psql(TEST_DB, ['-c', `SELECT role_id FROM users WHERE id = 'usr_legacy'`])).toBe('role_user');
    expect(await psql(TEST_DB, ['-c', "SELECT role_id || '|' || permission FROM role_permissions ORDER BY role_id, permission"])).toBe(
      ['role_admin|admin.all', 'role_user|user.read'].join('\n'),
    );

    // 0023 適用後は seed と同じ upsert が成功し、再実行（冪等）も通る。
    const upsert = [
      '-w',
      '-v',
      'ON_ERROR_STOP=1',
      '--dbname',
      databaseUrl(TEST_DB),
      '-c',
      `INSERT INTO roles (id, name, description) VALUES
         ('role_user', 'user', '一般ユーザー'), ('role_moderator', 'moderator', 'モデレーター（将来拡張）'),
         ('role_admin', 'admin', '管理者'), ('role_superadmin', 'superadmin', '最上位管理者（将来拡張）')
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description`,
    ];
    await expect(run('psql', upsert)).resolves.toBeDefined();
    await expect(run('psql', upsert)).resolves.toBeDefined();
    expect(await psql(TEST_DB, ['-c', 'SELECT count(*) FROM roles'])).toBe('4');
  });
});
