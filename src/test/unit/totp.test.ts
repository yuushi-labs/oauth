import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Secret, TOTP } from 'otpauth';

/**
 * `totp.ts` のテスト。`verifyAndConsumeTotp` は DB クエリに依存するため、クエリ層をモックして
 * 「delta から一致した counter を正しく決めているか」「atomic 消費の結果をどう扱うか」だけを検証する。
 */
const findTotpByUserId = vi.hoisted(() => vi.fn());
const consumeTotpCounter = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db/queries/totp', () => ({
  findTotpByUserId,
  consumeTotpCounter,
}));

import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  buildOtpauthUri,
  generateTotpSecret,
  verifyAndConsumeTotp,
} from '@/lib/auth/totp';
import { decryptTotpSecret, encryptTotpSecret } from '@/lib/auth/totp-crypto';

const FIXED_NOW = new Date('2026-10-24T00:00:00.000Z');

function codeFor(secretBase32: string, at: Date): string {
  return new TOTP({
    secret: Secret.fromBase32(secretBase32),
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).generate({ timestamp: at.getTime() });
}

function shift(seconds: number): Date {
  return new Date(FIXED_NOW.getTime() + seconds * 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateTotpSecret', () => {
  it('base32 の secret と、それを暗号化した値を返す', () => {
    const { base32, encrypted } = generateTotpSecret();
    // 20 バイト → base32 は 32 文字（パディング無し）
    expect(base32).toMatch(/^[A-Z2-7]+$/);
    expect(base32).toHaveLength(32);
    expect(encrypted).toMatch(/^v1\./);
    expect(decryptTotpSecret(encrypted)).toBe(base32);
  });

  it('毎回異なる secret を返す', () => {
    expect(generateTotpSecret().base32).not.toBe(generateTotpSecret().base32);
  });
});

describe('buildOtpauthUri', () => {
  it('issuer / label / digits=6 / period=30 / algorithm=SHA1 を含む', () => {
    const { base32 } = generateTotpSecret();
    const uri = buildOtpauthUri({ issuer: 'oauth', label: 'alice', secretBase32: base32 });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('oauth:alice');
    expect(uri).toContain(`secret=${base32}`);
    expect(uri).toContain('issuer=oauth');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('username の非 ASCII は URI エンコードされる', () => {
    const { base32 } = generateTotpSecret();
    const uri = buildOtpauthUri({ issuer: 'oauth', label: 'やまだ', secretBase32: base32 });
    expect(uri).toContain(encodeURIComponent('やまだ'));
  });
});

describe('verifyAndConsumeTotp', () => {
  it('行が無ければ invalid', async () => {
    findTotpByUserId.mockResolvedValue(null);
    const result = await verifyAndConsumeTotp({ userId: 'usr_1', code: '123456', now: FIXED_NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(consumeTotpCounter).not.toHaveBeenCalled();
  });

  it('無効化済み（enabled=false）なら invalid', async () => {
    const { base32, encrypted } = generateTotpSecret();
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: encrypted, enabled: false });
    const result = await verifyAndConsumeTotp({ userId: 'usr_1', code: codeFor(base32, FIXED_NOW), now: FIXED_NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('現在のコードは成功し、一致した counter を消費する', async () => {
    const { base32, encrypted } = generateTotpSecret();
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: encrypted, enabled: true });
    consumeTotpCounter.mockResolvedValue(true);

    const result = await verifyAndConsumeTotp({ userId: 'usr_1', code: codeFor(base32, FIXED_NOW), now: FIXED_NOW });
    expect(result).toEqual({ ok: true });

    const expectedCounter = TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: FIXED_NOW.getTime() });
    expect(consumeTotpCounter).toHaveBeenCalledWith('usr_1', expectedCounter, { allowPending: undefined });
  });

  it('window ±1: 30 秒前 / 現在 / 30 秒後 は成功、60 秒前 は失敗', async () => {
    const { base32, encrypted } = generateTotpSecret();
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: encrypted, enabled: true });
    consumeTotpCounter.mockResolvedValue(true);

    for (const offset of [-30, 0, 30]) {
      consumeTotpCounter.mockClear();
      const code = codeFor(base32, shift(offset));
      const result = await verifyAndConsumeTotp({ userId: 'usr_1', code, now: FIXED_NOW });
      expect(result, `offset=${offset}`).toEqual({ ok: true });
      expect(consumeTotpCounter, `offset=${offset}`).toHaveBeenCalledTimes(1);
    }

    consumeTotpCounter.mockClear();
    const oldCode = codeFor(base32, shift(-60));
    const result = await verifyAndConsumeTotp({ userId: 'usr_1', code: oldCode, now: FIXED_NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(consumeTotpCounter).not.toHaveBeenCalled();
  });

  it('delta が負でも「基準 + delta」の counter を消費する（過去ウィンドウ）', async () => {
    const { base32, encrypted } = generateTotpSecret();
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: encrypted, enabled: true });
    consumeTotpCounter.mockResolvedValue(true);

    const code = codeFor(base32, shift(-30));
    await verifyAndConsumeTotp({ userId: 'usr_1', code, now: FIXED_NOW });

    const base = TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: FIXED_NOW.getTime() });
    expect(consumeTotpCounter).toHaveBeenCalledWith('usr_1', base - 1, { allowPending: undefined });
  });

  it('delta が正でも「基準 + delta」の counter を消費する（未来ウィンドウ）', async () => {
    const { base32, encrypted } = generateTotpSecret();
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: encrypted, enabled: true });
    consumeTotpCounter.mockResolvedValue(true);

    const code = codeFor(base32, shift(30));
    await verifyAndConsumeTotp({ userId: 'usr_1', code, now: FIXED_NOW });

    const base = TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: FIXED_NOW.getTime() });
    expect(consumeTotpCounter).toHaveBeenCalledWith('usr_1', base + 1, { allowPending: undefined });
  });

  it('コードが一致しても counter 消費に失敗したら replayed（並行送信の 2 本目）', async () => {
    const { base32, encrypted } = generateTotpSecret();
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: encrypted, enabled: true });
    consumeTotpCounter.mockResolvedValue(false);

    const result = await verifyAndConsumeTotp({ userId: 'usr_1', code: codeFor(base32, FIXED_NOW), now: FIXED_NOW });
    expect(result).toEqual({ ok: false, reason: 'replayed' });
  });

  it('復号に失敗したら invalid（理由を返さない）', async () => {
    findTotpByUserId.mockResolvedValue({ userId: 'usr_1', secretEncrypted: 'broken-payload', enabled: true });
    const result = await verifyAndConsumeTotp({ userId: 'usr_1', code: '123456', now: FIXED_NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('定数は計画どおり（6 桁 / 30 秒 / window ±1）', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_WINDOW).toBe(1);
  });

  it('暗号化された secret は平文を含まない（DB に平文を置かない）', () => {
    const { base32, encrypted } = generateTotpSecret();
    expect(encrypted).not.toContain(base32);
    expect(encryptTotpSecret(base32)).not.toBe(base32);
  });
});
