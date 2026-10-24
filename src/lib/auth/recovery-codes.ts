import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@/lib/util/crypto';
import {
  consumeRecoveryCodeRow,
  countUnusedRecoveryCodes as countUnusedRecoveryCodeRows,
  deleteAllRecoveryCodes as deleteAllRecoveryCodeRows,
  insertRecoveryCodes,
} from '@/lib/db/queries/recovery-codes';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LOW_THRESHOLD = 3;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** 160 bit のランダム値を `XXXXX-XXXXX-XXXXX-XXXXX`（20 文字）に整形する。 */
function generateOne(): string {
  const raw = encodeBase32(randomBytes(20)).slice(0, 20);
  return raw.match(/.{1,5}/g)!.join('-');
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => generateOne());
}

/** 手入力のゆらぎ（大文字小文字・ハイフン・空白）を吸収する。 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(normalized: string): string {
  return sha256Hex(normalized);
}

/**
 * 1 個を atomic に消費する（D-33-12）。`used_at IS NULL` の単文 UPDATE の更新行数 = 1 でのみ成功。
 * 使用済みコードの再利用は 0 行更新になる（T4）。
 */
export async function consumeRecoveryCode(userId: string, input: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return false;
  return consumeRecoveryCodeRow(userId, hashRecoveryCode(normalized));
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  return countUnusedRecoveryCodeRows(userId);
}

export async function saveRecoveryCodes(userId: string, codes: string[]): Promise<void> {
  await insertRecoveryCodes(
    codes.map((code) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(code)) })),
  );
}

export async function deleteAllRecoveryCodes(userId: string): Promise<void> {
  await deleteAllRecoveryCodeRows(userId);
}
