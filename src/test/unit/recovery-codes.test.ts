import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/lib/util/crypto';

const consumeRecoveryCodeRow = vi.hoisted(() => vi.fn());
const countUnusedRecoveryCodesRow = vi.hoisted(() => vi.fn());
const deleteAllRecoveryCodesRow = vi.hoisted(() => vi.fn());
const insertRecoveryCodes = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db/queries/recovery-codes', () => ({
  consumeRecoveryCodeRow,
  countUnusedRecoveryCodes: countUnusedRecoveryCodesRow,
  deleteAllRecoveryCodes: deleteAllRecoveryCodesRow,
  insertRecoveryCodes,
}));

import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LOW_THRESHOLD,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  deleteAllRecoveryCodes,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  saveRecoveryCodes,
} from '@/lib/auth/recovery-codes';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateRecoveryCodes', () => {
  it('10 個生成され、全て異なる', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('形式は XXXXX-XXXXX-XXXXX-XXXXX（base32 風・20 文字）', () => {
    for (const code of generateRecoveryCodes()) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    }
  });
});

describe('normalizeRecoveryCode', () => {
  it('小文字・空白・ハイフン無しでも同じ値になる', () => {
    const canonical = 'ABCDE-FGHIJ-KLMNO-PQRST';
    const normalized = normalizeRecoveryCode(canonical);
    expect(normalized).toBe('ABCDEFGHIJKLMNOPQRST');
    expect(normalizeRecoveryCode('abcde fghij klmno pqrst')).toBe(normalized);
    expect(normalizeRecoveryCode('abcde-fghij-klmno-pqrst')).toBe(normalized);
    expect(normalizeRecoveryCode('ABCDEFGHIJKLMNOPQRST')).toBe(normalized);
  });

  it('記号は除去される', () => {
    expect(normalizeRecoveryCode('ab.cd/ef')).toBe('ABCDEF');
  });
});

describe('hashRecoveryCode', () => {
  it('決定的（同じ入力 → 同じ hash）で SHA-256 hex', () => {
    const normalized = normalizeRecoveryCode('ABCDE-FGHIJ-KLMNO-PQRST');
    const hash = hashRecoveryCode(normalized);
    expect(hash).toBe(hashRecoveryCode(normalized));
    expect(hash).toHaveLength(64);
    expect(hash).toBe(sha256Hex(normalized));
  });
});

describe('consumeRecoveryCode', () => {
  it('正規化してから hash で消費する', async () => {
    consumeRecoveryCodeRow.mockResolvedValue(true);
    const ok = await consumeRecoveryCode('usr_1', 'abcde-fghij-klmno-pqrst');
    expect(ok).toBe(true);
    expect(consumeRecoveryCodeRow).toHaveBeenCalledWith(
      'usr_1',
      sha256Hex('ABCDEFGHIJKLMNOPQRST'),
    );
  });

  it('空入力は DB を叩かず false', async () => {
    expect(await consumeRecoveryCode('usr_1', '   ---   ')).toBe(false);
    expect(consumeRecoveryCodeRow).not.toHaveBeenCalled();
  });

  it('使用済み（0 行更新）は false', async () => {
    consumeRecoveryCodeRow.mockResolvedValue(false);
    expect(await consumeRecoveryCode('usr_1', 'ABCDE-FGHIJ-KLMNO-PQRST')).toBe(false);
  });
});

describe('saveRecoveryCodes / count / delete', () => {
  it('保存は正規化 + hash 済みの行にする', async () => {
    await saveRecoveryCodes('usr_1', ['ABCDE-FGHIJ-KLMNO-PQRST']);
    expect(insertRecoveryCodes).toHaveBeenCalledWith([
      { userId: 'usr_1', codeHash: sha256Hex('ABCDEFGHIJKLMNOPQRST') },
    ]);
  });

  it('残数と全削除はクエリ層へ委譲する', async () => {
    countUnusedRecoveryCodesRow.mockResolvedValue(4);
    deleteAllRecoveryCodesRow.mockResolvedValue(undefined);
    expect(await countUnusedRecoveryCodes('usr_1')).toBe(4);
    await deleteAllRecoveryCodes('usr_1');
    expect(deleteAllRecoveryCodesRow).toHaveBeenCalledWith('usr_1');
  });

  it('低残数の閾値は 3', () => {
    expect(RECOVERY_CODE_LOW_THRESHOLD).toBe(3);
  });
});
