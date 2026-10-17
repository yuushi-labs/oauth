// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { query, selectResults, getEnvMock } = vi.hoisted(() => ({
  query: vi.fn(),
  selectResults: [] as unknown[],
  getEnvMock: vi.fn(() => ({ OIDC_MAX_CLIENTS_PER_USER: 5 })),
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => ({ query }),
  getDb: () => ({
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        where: () => {
        const result = {
          limit: async () => selectResults,
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(selectResults).then(resolve, reject),
        };
        return result;
      },
        then: async (resolve: (value: unknown[]) => unknown) => resolve(selectResults),
      }),
    }),
  }),
}));
vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), ...getEnvMock() }),
  };
});

import {
  createOidcClient,
  OidcClientForbiddenError,
  OidcClientLimitError,
  OidcClientNotFoundError,
  requireManageableClient,
  revokeOidcClient,
  rotateOidcClientSecret,
  updateOidcClient,
} from '@/lib/oidc/clients';

const owner = { userId: 'usr_owner', ip: '203.0.113.10', userAgent: 'vitest' };
const rows = (values: unknown[]) => ({ rows: values, rowCount: values.length });

function clientRow(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 'cli_target',
    client_type: 'confidential',
    redirect_uris: ['https://service.example/cb'],
    allowed_scopes: ['openid', 'email'],
    web_origins: [],
    owner_user_id: 'usr_owner',
    ...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  selectResults.length = 0;
});

describe('Security - OIDC console ownership boundary', () => {
  it('lets the owner manage their own client', async () => {
    query.mockImplementation(async (sql: string) => (sql.includes('SELECT client_type') ? rows([clientRow()]) : rows([{ client_id: 'cli_target' }])));
    const client = await requireManageableClient('cli_target', 'usr_owner');
    expect(client.clientId).toBe('cli_target');
  });

  it('denies another regular user', async () => {
    query.mockImplementation(async (sql: string) => (sql.includes('SELECT client_type') ? rows([clientRow()]) : rows([])));
    selectResults.push({ roleId: 'role_user' });
    await expect(requireManageableClient('cli_target', 'usr_attacker')).rejects.toBeInstanceOf(OidcClientForbiddenError);
  });

  it('lets an admin manage any client', async () => {
    query.mockImplementation(async (sql: string) => (sql.includes('SELECT client_type') ? rows([clientRow()]) : rows([])));
    selectResults.push({ roleId: 'role_admin' });
    await expect(requireManageableClient('cli_target', 'usr_admin')).resolves.toMatchObject({ clientId: 'cli_target' });
  });

  it('does not reveal whether another user\'s client exists', async () => {
    query.mockImplementation(async (sql: string) => (sql.includes('SELECT client_type') ? rows([clientRow()]) : rows([])));
    selectResults.push({ roleId: 'role_user' });
    await expect(updateOidcClient('cli_target', {
      name: 'x', operator: 'y', redirectUris: ['https://evil.example/cb'], scopes: ['openid'], webOrigins: [],
    }, { ...owner, userId: 'usr_attacker' })).rejects.toBeInstanceOf(OidcClientForbiddenError);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE oauth_clients'))).toBe(false);
  });

  it('does not rotate or revoke a client the actor does not own', async () => {
    query.mockImplementation(async (sql: string) => (sql.includes('SELECT client_type') ? rows([clientRow()]) : rows([])));
    selectResults.push({ roleId: 'role_user' });
    await expect(rotateOidcClientSecret('cli_target', { ...owner, userId: 'usr_attacker' })).rejects.toBeInstanceOf(OidcClientForbiddenError);
    await expect(revokeOidcClient('cli_target', { ...owner, userId: 'usr_attacker' })).rejects.toBeInstanceOf(OidcClientForbiddenError);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE oauth_clients'))).toBe(false);
  });

  it('answers 404 for revoked or unknown clients', async () => {
    query.mockImplementation(async () => rows([]));
    await expect(requireManageableClient('cli_gone', 'usr_owner')).rejects.toBeInstanceOf(OidcClientNotFoundError);
  });

  it('stores only the HMAC digest of the client secret', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('INSERT INTO oauth_clients')) {
        expect(params).toContain('usr_owner');
        const secret = params?.[8] as string;
        expect(secret).toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
      }
      return rows([]);
    });
    const created = await createOidcClient({
      name: 'App', operator: 'Op', clientType: 'confidential',
      redirectUris: ['https://service.example/cb'], scopes: ['openid'], webOrigins: [],
    }, owner);
    expect(created.clientSecret).toMatch(/^sec_/);
    const serialized = JSON.stringify(query.mock.calls);
    expect(serialized).not.toContain(created.clientSecret);
  });

  it('enforces the per-user client limit', async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('count(*)::int')) return rows([{ count: 5 }]);
      return rows([]);
    });
    selectResults.push({ count: 5 });
    await expect(createOidcClient({
      name: 'App', operator: 'Op', clientType: 'confidential',
      redirectUris: ['https://service.example/cb'], scopes: ['openid'], webOrigins: [],
    }, owner, { maxClientsPerUser: 5 })).rejects.toBeInstanceOf(OidcClientLimitError);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO oauth_clients'))).toBe(false);
  });

});
