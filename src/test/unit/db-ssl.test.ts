import { describe, expect, it } from 'vitest';
import { resolveDatabaseSsl } from '@/lib/db/ssl';
import { parseEnv, type EnvSource } from '@/lib/env';
import { generateTotpEncryptionKey } from '@/lib/util/crypto';

const VALID_ENV: EnvSource = {
  DATABASE_URL: 'postgresql://app:dev_password@localhost:5432/app',
  SESSION_PEPPER: 's'.repeat(43),
  TOKEN_PEPPER: 't'.repeat(43),
  IP_HASH_PEPPER: 'i'.repeat(43),
  CSRF_SECRET: 'c'.repeat(43),
  TOTP_ENCRYPTION_KEY: generateTotpEncryptionKey(),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

describe('DATABASE_SSL_MODE', () => {
  it('既定は disable（localhost の DB 前提）', () => {
    expect(parseEnv(VALID_ENV).DATABASE_SSL_MODE).toBe('disable');
  });

  it('未知の値は検証に失敗する', () => {
    expect(() => parseEnv({ ...VALID_ENV, DATABASE_SSL_MODE: 'prefer' })).toThrow();
  });

  it('disable は TLS を使わない', () => {
    expect(resolveDatabaseSsl('disable')).toBe(false);
  });

  it('require は TLS を使うが証明書を検証しない（自己署名の DB）', () => {
    expect(resolveDatabaseSsl('require')).toEqual({ rejectUnauthorized: false });
  });

  it('verify-full は TLS を使い証明書も検証する（正規 CA）', () => {
    expect(resolveDatabaseSsl('verify-full')).toEqual({ rejectUnauthorized: true });
  });

  it('NODE_ENV=production でも既定は disable のまま（旧挙動の暗黙 TLS をやめた）', () => {
    const env = parseEnv({ ...VALID_ENV, NODE_ENV: 'production' });
    expect(resolveDatabaseSsl(env.DATABASE_SSL_MODE)).toBe(false);
  });
});
