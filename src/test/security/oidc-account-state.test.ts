// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, encrypt, decrypt, idHash } = vi.hoisted(() => ({
  query: vi.fn(),
  encrypt: vi.fn((value: string) => `enc(${value})`),
  decrypt: vi.fn((value: string) => value.replace(/^enc\(/u, '').replace(/\)$/u, '')),
  idHash: vi.fn((value: string) => `hash(${value})`),
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => ({ query }),
  getDb: () => ({}),
}));
vi.mock('@/lib/oidc/crypto', () => ({
  encryptOidcValue: encrypt,
  decryptOidcValue: decrypt,
  oidcIdHash: idHash,
}));

import { PostgresOidcAdapter } from '@/lib/oidc/adapter';

const rows = (values: unknown[]) => ({ rows: values, rowCount: values.length });

function artifactRow(overrides: Record<string, unknown> = {}) {
  return rows([{ payload_ciphertext: encrypt(JSON.stringify({ accountId: 'usr_1', grantId: 'gra_1', clientId: 'cli_1', ...overrides })), consumed_at: null }]);
}

describe('Security - OIDC artifact account state', () => {
  beforeEach(() => {
    query.mockReset();
    encrypt.mockClear();
    decrypt.mockClear();
    idHash.mockClear();
  });

  it.each([
    ['suspended', 0],
    ['deleted', 0],
    ['pending_email', 0],
  ])('access token を status=%s のユーザーで解決しない', async (_status, usableRows) => {
    query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('expires_at > now()');
      return artifactRow();
    });
    query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain('email_verified = true');
      expect(sql).toContain('deleted_at IS NULL');
      return rows(Array.from({ length: usableRows }, () => ({})));
    });

    const found = await new PostgresOidcAdapter('AccessToken').find('token-id');
    expect(found).toBeUndefined();
  });

  it('authorization code も accounts 状態で拒否する', async () => {
    query.mockImplementationOnce(async () => artifactRow());
    query.mockImplementationOnce(async () => rows([]));

    expect(await new PostgresOidcAdapter('AuthorizationCode').find('code-id')).toBeUndefined();
  });

  it('grant / session も accounts 状態で拒否する', async () => {
    for (const model of ['Grant', 'Session']) {
      query.mockReset();
      query.mockImplementationOnce(async () => artifactRow());
      query.mockImplementationOnce(async () => rows([]));
      expect(await new PostgresOidcAdapter(model).find('artifact-id'), model).toBeUndefined();
    }
  });

  it('accountId を持たない artifact（Client 等）は account 判定を行わない', async () => {
    query.mockImplementationOnce(async () => rows([{ payload_ciphertext: encrypt(JSON.stringify({ foo: 'bar' })), consumed_at: null }]));

    expect(await new PostgresOidcAdapter('DeviceCode').find('device-id')).toEqual({ foo: 'bar' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('active ユーザーなら client / grant の失効を引き続き検証する', async () => {
    query.mockImplementationOnce(async () => artifactRow());
    query.mockImplementationOnce(async () => rows([{}]));
    query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('active = true');
      expect(sql).toContain('revoked_at IS NULL');
      return rows([{}]);
    });
    query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('oidc_user_grants');
      expect(sql).toContain('revoked_at IS NULL');
      return rows([{}]);
    });

    expect(await new PostgresOidcAdapter('AccessToken').find('token-id')).toBeTruthy();
  });

  it('失効済み client の access token を拒否する', async () => {
    query.mockImplementationOnce(async () => artifactRow());
    query.mockImplementationOnce(async () => rows([{}]));
    query.mockImplementationOnce(async () => rows([]));

    expect(await new PostgresOidcAdapter('AccessToken').find('token-id')).toBeUndefined();
  });
});