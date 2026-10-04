import { describe, expect, it } from 'vitest';
import {
  generatePepper,
  generateTotpEncryptionKey,
  hmacSha256Hex,
  randomToken,
  sha1Hex,
  sha256Hex,
  timingSafeEqualStr,
} from '@/lib/util/crypto';

describe('randomToken', () => {
  it('32バイトなら base64url 43文字になる', () => {
    const token = randomToken(32);
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('既定長も 43文字になる', () => {
    expect(randomToken()).toHaveLength(43);
  });

  it('毎回異なる値を返す', () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('sha256Hex / sha1Hex', () => {
  it('SHA-256 は hex 64文字', () => {
    const hash = sha256Hex('user@example.com');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(sha256Hex('user@example.com'));
    expect(hash).not.toBe(sha256Hex('user2@example.com'));
  });

  it('SHA-1 は hex 40文字（HIBP k-anonymity 用・Phase 1-A）', () => {
    expect(sha1Hex('password')).toHaveLength(40);
  });
});

describe('hmacSha256Hex', () => {
  it('同じ鍵・同じ値なら同じ hash', () => {
    expect(hmacSha256Hex('pepper', '203.0.113.45')).toBe(hmacSha256Hex('pepper', '203.0.113.45'));
  });

  it('鍵が違うと hash も変わる', () => {
    expect(hmacSha256Hex('pepper-a', '203.0.113.45')).not.toBe(
      hmacSha256Hex('pepper-b', '203.0.113.45'),
    );
  });
});

describe('timingSafeEqualStr', () => {
  it('一致すれば true', () => {
    expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true);
  });

  it('不一致・長さ違いで false', () => {
    expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcdef')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});

describe('鍵の生成', () => {
  it('pepper は 32バイト以上', () => {
    const pepper = generatePepper();
    expect(Buffer.from(pepper, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(pepper).not.toBe(generatePepper());
  });

  it('TOTP 鍵は Base64 で32バイト', () => {
    expect(Buffer.from(generateTotpEncryptionKey(), 'base64').length).toBe(32);
  });
});