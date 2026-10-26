import { describe, expect, it } from 'vitest';
import { resolveWebauthnConfig } from '@/lib/auth/passkey/config';

const base = {
  NODE_ENV: 'development',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'Test App',
  WEBAUTHN_ALLOWED_ORIGINS: 'http://localhost:3000',
};

describe('resolveWebauthnConfig', () => {
  it('development では明示設定をそのまま解決する', () => {
    const config = resolveWebauthnConfig(base);
    expect(config.rpID).toBe('localhost');
    expect(config.rpName).toBe('Test App');
    expect(config.allowedOrigins).toEqual(['http://localhost:3000']);
  });

  it('development で未設定なら localhost の既定値を使う', () => {
    const config = resolveWebauthnConfig({ NODE_ENV: 'development' });
    expect(config.rpID).toBe('localhost');
    expect(config.allowedOrigins).toEqual(['http://localhost:3000']);
  });

  it('複数 origin をカンマ区切りで受け取る', () => {
    const config = resolveWebauthnConfig({
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'example.com',
      WEBAUTHN_RP_NAME: 'App',
      WEBAUTHN_ALLOWED_ORIGINS: 'https://example.com, https://www.example.com',
    });
    expect(config.allowedOrigins).toEqual(['https://example.com', 'https://www.example.com']);
  });

  it('production で WEBAUTHN_RP_ID 未設定なら throw', () => {
    expect(() =>
      resolveWebauthnConfig({ NODE_ENV: 'production', WEBAUTHN_ALLOWED_ORIGINS: 'https://example.com' }),
    ).toThrow();
  });

  it('production で WEBAUTHN_ALLOWED_ORIGINS 未設定なら throw', () => {
    expect(() =>
      resolveWebauthnConfig({ NODE_ENV: 'production', WEBAUTHN_RP_ID: 'example.com' }),
    ).toThrow();
  });

  it('production で rpID が localhost なら throw', () => {
    expect(() =>
      resolveWebauthnConfig({
        NODE_ENV: 'production',
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://localhost',
      }),
    ).toThrow();
  });

  it('production で許可 origin に localhost を含むなら throw', () => {
    expect(() =>
      resolveWebauthnConfig({
        NODE_ENV: 'production',
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://example.com,http://localhost:3000',
      }),
    ).toThrow();
  });

  it('許可 origin が絶対 URL でないなら throw', () => {
    expect(() =>
      resolveWebauthnConfig({
        NODE_ENV: 'development',
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_ALLOWED_ORIGINS: 'localhost:3000',
      }),
    ).toThrow();
  });

  it('production で http（非 https）の origin は throw', () => {
    expect(() =>
      resolveWebauthnConfig({
        NODE_ENV: 'production',
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ALLOWED_ORIGINS: 'http://example.com',
      }),
    ).toThrow();
  });

  it('origin の host が rpID と一致しない（サフィックスでもない）なら throw', () => {
    expect(() =>
      resolveWebauthnConfig({
        NODE_ENV: 'production',
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://evil.example.org',
      }),
    ).toThrow();
  });

  it('origin の host が rpID のサブドメインなら許容する', () => {
    const config = resolveWebauthnConfig({
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'example.com',
      WEBAUTHN_RP_NAME: 'App',
      WEBAUTHN_ALLOWED_ORIGINS: 'https://login.example.com',
    });
    expect(config.allowedOrigins).toEqual(['https://login.example.com']);
  });

  it('origin の host が rpID のスーパードメイン（rpID を含まない）なら throw', () => {
    expect(() =>
      resolveWebauthnConfig({
        NODE_ENV: 'production',
        WEBAUTHN_RP_ID: 'login.example.com',
        WEBAUTHN_ALLOWED_ORIGINS: 'https://example.com',
      }),
    ).toThrow();
  });
});
