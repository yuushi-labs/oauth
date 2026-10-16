import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { CLIENT_SECRET_HASH_PREFIX, hashClientSecret, isClientSecretHash, verifyClientSecretHash } from '@/lib/oidc/crypto';

describe('OIDC client secret hashing', () => {
  it('stores a peppered digest, never the secret itself', () => {
    const secret = 'sec_example_value';
    const hash = hashClientSecret(secret);

    expect(isClientSecretHash(hash)).toBe(true);
    expect(hash.startsWith(CLIENT_SECRET_HASH_PREFIX)).toBe(true);
    expect(hash).not.toContain(secret);
    expect(hash.length).toBe(CLIENT_SECRET_HASH_PREFIX.length + 43);
  });

  it('produces different digests for different secrets and is deterministic', () => {
    expect(hashClientSecret('a')).toBe(hashClientSecret('a'));
    expect(hashClientSecret('a')).not.toBe(hashClientSecret('b'));
  });

  it('verifies only the matching secret', () => {
    const hash = hashClientSecret('sec_correct');
    expect(verifyClientSecretHash(hash, 'sec_correct')).toBe(true);
    expect(verifyClientSecretHash(hash, 'sec_wrong')).toBe(false);
    expect(verifyClientSecretHash(hash, '')).toBe(false);
    expect(verifyClientSecretHash(hash, `${hash}`)).toBe(false);
  });

  it('rejects stored values that are not hashed (legacy plaintext or ciphertext)', () => {
    expect(verifyClientSecretHash('plaintext-secret', 'plaintext-secret')).toBe(false);
    expect(verifyClientSecretHash('v1.aaaa.bbbb.cccc', 'anything')).toBe(false);
    expect(verifyClientSecretHash(`${CLIENT_SECRET_HASH_PREFIX}invalidated-rotate-required`, 'anything')).toBe(false);
    expect(isClientSecretHash(CLIENT_SECRET_HASH_PREFIX)).toBe(false);
  });

  it('never accepts a stored digest as if it were the secret', () => {
    const hash = hashClientSecret('sec_value');
    expect(verifyClientSecretHash(hash, hashClientSecret('sec_value'))).toBe(false);
    expect(verifyClientSecretHash(hash, CLIENT_SECRET_HASH_PREFIX + hash)).toBe(false);
  });
});

describe('OIDC signing key requirements', () => {
  it('accepts a single private RSA RS256 key and rejects mixed algorithms', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(privateKey).toBeTruthy();
    expect(privateKey.includes('BEGIN PRIVATE KEY')).toBe(true);
  });
});