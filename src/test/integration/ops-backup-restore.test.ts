import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createBackup, readEncryptedBackup } from '@/lib/ops/backup';
import { runCommand, type CommandRunner } from '@/lib/ops/command';
import { restoreBackup } from '@/lib/ops/restore';

/**
 * バックアップ → 復元の実証（Phase 9 / P9-A-04・D-39-02）。
 *
 * 実 `pg_dump` / `pg_restore` を使い、**別の一時 DB へ復元して行数を確認**する。
 * 本番 DB を破壊しないよう、復元先は必ず一時 DB にする。
 */

const run = promisify(execFile);
const KEY = randomBytes(32).toString('base64');
const SOURCE_DB = 'oauth_phase9_backup_src';
const TARGET_DB = 'oauth_phase9_backup_dst';

function databaseUrl(dbName: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required for this test');
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** `createdb` / `dropdb` に渡す接続引数（socket ではなく URL の host/port/user を使う）。 */
function adminArgs(): string[] {
  const url = new URL(process.env.DATABASE_URL ?? '');
  // `-w` は「パスワードを対話で尋ねない」。未設定なら即失敗させ、テストを止めない。
  return ['-w', '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
}

async function createDatabase(name: string): Promise<void> {
  await run('dropdb', ['--if-exists', '--force', ...adminArgs(), name]).catch(() => undefined);
  await run('createdb', [...adminArgs(), name]);
}

async function dropDatabase(name: string): Promise<void> {
  await run('dropdb', ['--if-exists', '--force', ...adminArgs(), name]).catch(() => undefined);
}

async function tableCount(dbName: string, table: string): Promise<number> {
  const { stdout } = await run('psql', ['-w', '--tuples-only', '--no-align', '--dbname', databaseUrl(dbName), '-c', `SELECT count(*) FROM ${table}`]);
  return Number(stdout.trim());
}

let outDir: string;
/** `pg_dump` / `pg_restore` の実行器（ホストのクライアントがサーバーとメジャー一致しなければコンテナ内を使う）。 */
let pg: CommandRunner = runCommand;

/** サーバーのメジャーバージョン。 */
async function serverMajorVersion(): Promise<number> {
  const { stdout } = await run('psql', [
    '-w', '--tuples-only', '--no-align',
    '--dbname', process.env.DATABASE_URL ?? '',
    '-c', 'SHOW server_version_num',
  ]);
  return Math.floor(Number(stdout.trim()) / 10000);
}

async function clientMajorVersion(bin: string): Promise<number | null> {
  try {
    const { stdout } = await run(bin, ['--version']);
    const match = /(\d+)/.exec(stdout);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 実 `pg_dump` / `pg_restore` を、**DB サーバーと同じメジャー**のものに揃える。
 *
 * クライアントのメジャーがサーバーより新しいと、dump にサーバーが知らない GUC
 * （`transaction_timeout` など）が含まれ、`pg_restore` で失敗する。GitHub Actions の
 * ランナーは PostgreSQL 16 のサービスコンテナより新しいクライアントを持っているため、
 * 一致しないときはサーバーと同じメージのコンテナ内で実行する。
 */
async function choosePgRunner(): Promise<{ runner: CommandRunner; note: string }> {
  const [serverMajor, clientMajor] = await Promise.all([
    serverMajorVersion(),
    clientMajorVersion('pg_dump'),
  ]);
  if (clientMajor === serverMajor) return { runner: runCommand, note: `host pg_dump (${clientMajor})` };

  const image = `postgres:${serverMajor}-alpine`;
  const runner: CommandRunner = (command, args, stdin) =>
    runCommand('docker', ['run', '--rm', '-i', '--network', 'host', image, command, ...args], stdin);
  return { runner, note: `container ${image} (host pg_dump=${clientMajor ?? 'なし'})` };
}

beforeAll(async () => {
  // 子プロセス（pg_dump / pg_restore / psql）が非対話で認証できるよう、DB パスワードを
  // 環境へ載せる。`-w` と併せて、認証に失敗したら対話待ちにせず即エラーにする。
  const url = new URL(process.env.DATABASE_URL ?? '');
  process.env.PGPASSWORD = decodeURIComponent(url.password);
  const chosen = await choosePgRunner();
  pg = chosen.runner;
  outDir = await mkdtemp(join(tmpdir(), 'oauth-backup-'));
  process.stdout.write(`# backup test: pg_dump / pg_restore = ${chosen.note}\n`);
  await createDatabase(SOURCE_DB);
  // roles は seed で入る固定行。検証用に「バックアップ時点の行数」を確定させる。
  await run('psql', ['-w', '--dbname', databaseUrl(SOURCE_DB), '-c', `
    CREATE TABLE IF NOT EXISTS phase9_probe (id integer primary key, note text not null);
    INSERT INTO phase9_probe (id, note) VALUES (1, 'before-backup');
  `]);
});

afterAll(async () => {
  await dropDatabase(SOURCE_DB);
  await dropDatabase(TARGET_DB);
  await rm(outDir, { recursive: true, force: true });
});

describe('Phase 9 - backup and restore (real pg_dump / pg_restore)', () => {
  it('★ encrypts the dump and restores it into a separate database', async () => {
    const path = await createBackup({ outDir, key: KEY, databaseUrl: databaseUrl(SOURCE_DB), run: pg });

    // 暗号化されている（平文の dump がそのまま残っていない）。
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(path));
    expect(raw.toString('utf8')).not.toContain('before-backup');
    expect(raw.subarray(0, 5).toString('utf8')).not.toBe('PGDMP');

    // ファイル権限は 0o600。
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);

    // 復元先を別 DB として作り、そこへ流す。
    await createDatabase(TARGET_DB);
    await restoreBackup({ file: path, key: KEY, databaseUrl: databaseUrl(TARGET_DB), run: pg });

    expect(await tableCount(TARGET_DB, 'phase9_probe')).toBe(1);
    const { stdout } = await run('psql', ['-w', '--tuples-only', '--no-align', '--dbname', databaseUrl(TARGET_DB), '-c', 'SELECT note FROM phase9_probe WHERE id = 1']);
    expect(stdout.trim()).toBe('before-backup');
  }, 120_000);

  it('round-trips the encrypted payload without leaving plaintext', async () => {
    const path = await createBackup({ outDir, key: KEY, databaseUrl: databaseUrl(SOURCE_DB), run: pg });
    const decrypted = await readEncryptedBackup(path, KEY);
    // pg_dump custom 形式のマジックナンバー（PGDMP）が復号後に現れる。
    expect(decrypted.subarray(0, 5).toString('utf8')).toBe('PGDMP');
  }, 120_000);
});
