import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_RETENTION_DAYS } from '@/config/ops';
import { runCommand, type CommandRunner } from './command';

/**
 * バックアップの暗号化と保持（Phase 9 / D-39-02・D-39-03）。
 *
 * `pg_dump` の出力は機密（§53）なので、**必ず AES-256-GCM で暗号化してから**保存する。
 * 平文のダンプは一時ファイルにも残さない（`createBackup` はパイプで受け取って暗号化する）。
 * 鍵は `BACKUP_ENCRYPTION_KEY`（Base64 32 バイト）で注入し、鍵未設定なら失敗する。
 */

const AAD = Buffer.from('oauth-backup-v1', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const BACKUP_PREFIX = 'backup-';
export const BACKUP_SUFFIX = '.dump.enc';

export class BackupKeyError extends Error {
  constructor() {
    super('BACKUP_ENCRYPTION_KEY が未設定です（平文でのバックアップは行いません）');
    this.name = 'BackupKeyError';
  }
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('バックアップ暗号鍵は Base64 32 バイトである必要があります');
  return key;
}

/** 平文 → `iv(12) || authTag(16) || ciphertext`。 */
export function encryptBackup(plain: Buffer, keyBase64: string): Buffer {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** 復号。鍵不一致・改竄・形式不正はすべて throw する（呼び出し側で失敗させる）。 */
export function decryptBackup(encrypted: Buffer, keyBase64: string): Buffer {
  const key = decodeKey(keyBase64);
  if (encrypted.length < IV_BYTES + TAG_BYTES) throw new Error('バックアップファイルが不正です');
  const iv = encrypted.subarray(0, IV_BYTES);
  const tag = encrypted.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = encrypted.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** `backup-<ISO8601>.dump.enc`（`:` と `.` はファイル名の衝突を避けて `-` へ）。 */
export function backupFileName(date: Date): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
}

/** `backup-<ISO8601>.dump.enc` から日時を戻す。形式が違えば null。 */
export function parseBackupDate(name: string): Date | null {
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) return null;
  const stamp = name.slice(BACKUP_PREFIX.length, -BACKUP_SUFFIX.length);
  const date = new Date(stamp.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z'));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 保持期間を過ぎたバックアップ名を返す（`now` を注入してテスト可能にする）。
 * `keepDays` ちょうどの時刻は「期限内」として残す。
 */
export function selectExpiredBackups(names: string[], now: Date, keepDays: number): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return names.filter((name) => {
    const date = parseBackupDate(name);
    if (!date) return false;
    return date.getTime() < cutoff;
  });
}

/** コマンド実行の差し替え口（テストで `pg_dump` を叩かないため）。 */
export type { CommandRunner };

export type CreateBackupOptions = {
  outDir: string;
  key: string | undefined;
  databaseUrl: string;
  keepDays?: number;
  now?: Date;
  run?: CommandRunner;
};

/**
 * `pg_dump` → 暗号化 → 保存 → pruning。
 * 平文ダンプは一時ファイルに書き出さず、パイプで受け取って暗号化する（§53）。
 */
export async function createBackup(options: CreateBackupOptions): Promise<string> {
  if (!options.key) throw new BackupKeyError();
  const run = options.run ?? runCommand;
  const now = options.now ?? new Date();
  await mkdir(options.outDir, { recursive: true });

  const dump = await run('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--dbname',
    options.databaseUrl,
  ]);
  const encrypted = encryptBackup(dump, options.key);
  const path = join(options.outDir, backupFileName(now));
  await writeFile(path, encrypted, { mode: 0o600 });
  await pruneBackups({ outDir: options.outDir, keepDays: options.keepDays, now });
  return path;
}

export type PruneOptions = { outDir: string; keepDays?: number; now?: Date };

/** 保持期間を過ぎたバックアップを削除し、削除した名前を返す。 */
export async function pruneBackups(options: PruneOptions): Promise<string[]> {
  const keepDays = options.keepDays ?? BACKUP_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const names = (await readdir(options.outDir)).filter((name) => name.startsWith(BACKUP_PREFIX));
  const expired = selectExpiredBackups(names, now, keepDays);
  await Promise.all(expired.map((name) => rm(join(options.outDir, name), { force: true })));
  return expired;
}

/** バックアップファイルを復号して読み出す（復元の前段）。 */
export async function readEncryptedBackup(path: string, key: string): Promise<Buffer> {
  return decryptBackup(await readFile(path), key);
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
