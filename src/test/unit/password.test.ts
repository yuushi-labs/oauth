import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword, needsRehash, isArgon2Hash } from '@/lib/auth/password';

describe('password - Argon2id', () => {
  const testPassword = 'TestPassword123!あいうえお';

  it('hashPassword returns Argon2id hash', async () => {
    const hash = await hashPassword(testPassword);
    expect(isArgon2Hash(hash)).toBe(true);
    expect(hash).toContain('$argon2id$');
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword(testPassword);
    const result = await verifyPassword(testPassword, hash);
    expect(result).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword(testPassword);
    const result = await verifyPassword('WrongPassword456!', hash);
    expect(result).toBe(false);
  });

  it('different hashes for same password (salt)', async () => {
    const hash1 = await hashPassword(testPassword);
    const hash2 = await hashPassword(testPassword);
    expect(hash1).not.toBe(hash2);
    // Both should verify
    expect(await verifyPassword(testPassword, hash1)).toBe(true);
    expect(await verifyPassword(testPassword, hash2)).toBe(true);
  });

  it('verifyPassword returns false for non-Argon2 hash', async () => {
    const result = await verifyPassword('test', 'not-a-hash');
    expect(result).toBe(false);
  });

  it('verifyPassword returns false for empty hash', async () => {
    const result = await verifyPassword('test', '');
    expect(result).toBe(false);
  });
});

describe('needsRehash', () => {
  it('returns true for non-Argon2 hash', () => {
    expect(needsRehash('$pbkdf2-sha256$...')).toBe(true);
  });

  it('returns true for invalid hash', () => {
    expect(needsRehash('invalid')).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(needsRehash('')).toBe(true);
  });
});

describe('isArgon2Hash', () => {
  it('returns true for argon2id hash', () => {
    expect(isArgon2Hash('$argon2id$v=19$m=19456,t=2,p=1$...$...')).toBe(true);
  });

  it('returns true for argon2i hash', () => {
    expect(isArgon2Hash('$argon2i$v=19$m=19456,t=2,p=1$...$...')).toBe(true);
  });

  it('returns true for argon2d hash', () => {
    expect(isArgon2Hash('$argon2d$v=19$m=19456,t=2,p=1$...$...')).toBe(true);
  });

  it('returns false for non-argon2 hash', () => {
    expect(isArgon2Hash('$pbkdf2-sha256$...')).toBe(false);
    expect(isArgon2Hash('bcrypt$...')).toBe(false);
    expect(isArgon2Hash('plaintext')).toBe(false);
  });
});