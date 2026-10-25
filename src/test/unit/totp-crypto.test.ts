import { describe, expect, it } from 'vitest';
import { decryptTotpSecret, encryptTotpSecret } from '@/lib/auth/totp-crypto';

/**
 * §13.1 / D-33-03: secret は AES-256-GCM（`TOTP_ENCRYPTION_KEY`）で保存する。
 * 鍵は `getEnv()` から読むため、テストは `src/test/setup.ts` が注入する。
 */
describe('totp-crypto', () => {
  it('暗号化 → 復号で元の平文に戻る', () => {
    const plaintext = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = encryptTotpSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptTotpSecret(encrypted)).toBe(plaintext);
  });

  it('形式は v1.<nonce>.<tag>.<ciphertext>（base64url）', () => {
    const encrypted = encryptTotpSecret('secret-value');
    const parts = encrypted.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    // nonce は 12 バイト → base64url で 16 文字
    expect(parts[1]).toHaveLength(16);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('同じ平文でも nonce がランダムなので暗号文は毎回異なる', () => {
    const plaintext = 'same-plaintext';
    const a = encryptTotpSecret(plaintext);
    const b = encryptTotpSecret(plaintext);
    expect(a).not.toBe(b);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
    expect(decryptTotpSecret(a)).toBe(plaintext);
    expect(decryptTotpSecret(b)).toBe(plaintext);
  });

  it('改竄（tag 書換）は throw する', () => {
    const [version, nonce, tag, ciphertext] = encryptTotpSecret('tamper-me').split('.');
    const flipped = tag!.startsWith('A') ? `B${tag!.slice(1)}` : `A${tag!.slice(1)}`;
    expect(() => decryptTotpSecret([version, nonce, flipped, ciphertext].join('.'))).toThrow();
  });

  it('暗号文の改竄も throw する', () => {
    const [version, nonce, tag, ciphertext] = encryptTotpSecret('tamper-me').split('.');
    const flipped = ciphertext!.startsWith('A') ? `B${ciphertext!.slice(1)}` : `A${ciphertext!.slice(1)}`;
    expect(() => decryptTotpSecret([version, nonce, tag, flipped].join('.'))).toThrow();
  });

  it('形式不正は throw する', () => {
    expect(() => decryptTotpSecret('not-a-valid-payload')).toThrow();
    expect(() => decryptTotpSecret('v2.a.b.c')).toThrow();
    expect(() => decryptTotpSecret('v1..b.c')).toThrow();
    expect(() => decryptTotpSecret('')).toThrow();
  });
});
