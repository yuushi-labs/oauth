import { describe, expect, it } from 'vitest';
import { generateTotpEncryptionKey } from '@/lib/util/crypto';
import { EnvValidationError, parseEnv, type EnvSource } from '@/lib/env';

const VALID_ENV: EnvSource = {
  DATABASE_URL: 'postgresql://app:dev_password@localhost:5432/app',
  SESSION_PEPPER: 's'.repeat(43),
  TOKEN_PEPPER: 't'.repeat(43),
  IP_HASH_PEPPER: 'i'.repeat(43),
  CSRF_SECRET: 'c'.repeat(43),
  TOTP_ENCRYPTION_KEY: generateTotpEncryptionKey(),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('必須変数が揃っていれば検証を通る', () => {
    const env = parseEnv(VALID_ENV);
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('任意変数は既定値が入る', () => {
    const env = parseEnv({ ...VALID_ENV, HIBP_TIMEOUT_MS: '2500', BREACH_CHECK_FAIL_OPEN: 'false' });
    expect(env.HIBP_TIMEOUT_MS).toBe(2500);
    expect(env.BREACH_CHECK_FAIL_OPEN).toBe(false);
  });

  it('BREACH_CHECK_FAIL_OPEN は文字列 "false" を false として扱う（D-17）', () => {
    expect(parseEnv({ ...VALID_ENV, BREACH_CHECK_FAIL_OPEN: 'false' }).BREACH_CHECK_FAIL_OPEN).toBe(
      false,
    );
    expect(parseEnv({ ...VALID_ENV, BREACH_CHECK_FAIL_OPEN: 'true' }).BREACH_CHECK_FAIL_OPEN).toBe(
      true,
    );
  });

  it('必須変数の欠落を列挙して fail fast する', () => {
    const result = (() => {
      try {
        parseEnv({});
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(result).toBeInstanceOf(EnvValidationError);
    const issues = (result as EnvValidationError).issues.join('\n');
    for (const key of [
      'DATABASE_URL',
      'SESSION_PEPPER',
      'TOKEN_PEPPER',
      'IP_HASH_PEPPER',
      'CSRF_SECRET',
      'TOTP_ENCRYPTION_KEY',
      'NEXT_PUBLIC_APP_URL',
    ]) {
      expect(issues).toContain(key);
    }
  });

  it('pepper が 32文字未満なら拒否する', () => {
    expect(() => parseEnv({ ...VALID_ENV, SESSION_PEPPER: 'short' })).toThrow(/SESSION_PEPPER/);
  });

  it('TOTP_ENCRYPTION_KEY が Base64 32バイトでなければ拒否する', () => {
    expect(() => parseEnv({ ...VALID_ENV, TOTP_ENCRYPTION_KEY: 'not-base64-32b' })).toThrow(
      /TOTP_ENCRYPTION_KEY/,
    );
  });

  it('不正な URL を拒否する', () => {
    expect(() => parseEnv({ ...VALID_ENV, NEXT_PUBLIC_APP_URL: 'localhost' })).toThrow(
      /NEXT_PUBLIC_APP_URL/,
    );
  });
});