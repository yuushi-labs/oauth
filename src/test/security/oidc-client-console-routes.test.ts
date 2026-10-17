// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { deriveCsrfToken } from '@/lib/auth/pipeline';

const session = { id: 'ses_1', userId: 'usr_owner', csrfSecret: 'csrf-secret', reauthVerifiedAt: null };
const user = { id: 'usr_owner', email: 'owner@example.com', roleId: 'role_user' };

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => session) };
});
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return { ...actual, findUserById: vi.fn(async () => user) };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: { check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })) },
}));

vi.mock('@/lib/db/client', () => ({
  getPool: () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  getDb: () => ({ select: () => ({ from: () => ({ where: () => [] }) }), insert: () => ({ values: async () => undefined }) }),
}));

import {
  createOidcClient,
  OidcClientForbiddenError,
  OidcClientNotFoundError,
  revokeOidcClient,
  rotateOidcClientSecret,
  updateOidcClient,
} from '@/lib/oidc/clients';

vi.mock('@/lib/oidc/clients', async () => {
  const actual = await vi.importActual<typeof import('@/lib/oidc/clients')>('@/lib/oidc/clients');
  return {
    ...actual,
    updateOidcClient: vi.fn(),
    rotateOidcClientSecret: vi.fn(),
    revokeOidcClient: vi.fn(),
    requireManageableClient: vi.fn(),
    listOidcClients: vi.fn(async () => []),
    createOidcClient: vi.fn(),
  };
});

import { PATCH, DELETE } from '@/app/api/auth/oidc/clients/[clientId]/route';
import { POST as rotateSecret } from '@/app/api/auth/oidc/clients/[clientId]/secret/route';
import { POST as createClientRoute } from '@/app/api/auth/oidc/clients/route';
import { POST as startTest } from '@/app/api/auth/oidc/clients/[clientId]/test/start/route';

const appUrl = 'http://localhost:3000';
const context = { params: Promise.resolve({ clientId: 'cli_target' }) };

function jsonRequest(path: string, body: unknown, options: { csrf?: string; origin?: string; method?: string } = {}) {
  const method = options.method ?? 'PATCH';
  return new NextRequest(new Request(`${appUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? appUrl,
      cookie: 'auth_session=test-session-token',
      'x-csrf-token': options.csrf ?? deriveCsrfToken(session),
    },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.stubEnv('OIDC_ISSUER', appUrl);
  vi.mocked(updateOidcClient).mockReset();
  vi.mocked(rotateOidcClientSecret).mockReset();
  vi.mocked(revokeOidcClient).mockReset();
  vi.mocked(createOidcClient).mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe('Security - OIDC console client routes', () => {
  it('hides other users\' clients behind 404 on update', async () => {
    vi.mocked(updateOidcClient).mockRejectedValue(new OidcClientForbiddenError());
    const response = await PATCH(jsonRequest('/api/auth/oidc/clients/cli_target', {
      name: 'stolen', operator: 'attacker', redirectUris: ['https://evil.example/cb'], scopes: ['openid'], webOrigins: [],
    }), context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('アプリが見つかりません');
  });

  it('hides other users\' clients behind 404 on revoke and secret rotation', async () => {
    vi.mocked(revokeOidcClient).mockRejectedValue(new OidcClientNotFoundError());
    vi.mocked(rotateOidcClientSecret).mockRejectedValue(new OidcClientNotFoundError());
    session.reauthVerifiedAt = new Date().toISOString();
    const revoked = await DELETE(jsonRequest('/api/auth/oidc/clients/cli_target', {}, { method: 'DELETE' }), context);
    const rotated = await rotateSecret(jsonRequest('/api/auth/oidc/clients/cli_target/secret', {}), context);
    expect(revoked.status).toBe(404);
    expect(rotated.status).toBe(404);
    session.reauthVerifiedAt = null;
  });

  it('requires reauthentication before revoking or rotating a secret', async () => {
    session.reauthVerifiedAt = null;
    const revoked = await DELETE(jsonRequest('/api/auth/oidc/clients/cli_target', {}, { method: 'DELETE' }), context);
    const rotated = await rotateSecret(jsonRequest('/api/auth/oidc/clients/cli_target/secret', {}), context);
    expect(revoked.status).toBe(401);
    expect(rotated.status).toBe(401);
    expect(vi.mocked(revokeOidcClient)).not.toHaveBeenCalled();
    expect(vi.mocked(rotateOidcClientSecret)).not.toHaveBeenCalled();
  });

  it('rejects mutations without a valid CSRF token', async () => {
    const response = await PATCH(jsonRequest('/api/auth/oidc/clients/cli_target', {
      name: 'x', operator: 'y', redirectUris: ['https://service.example/cb'], scopes: ['openid'], webOrigins: [],
    }, { csrf: 'forged' }), context);
    expect(response.status).toBe(403);
    expect(vi.mocked(updateOidcClient)).not.toHaveBeenCalled();
  });

  it('rejects cross-origin mutations even with a valid CSRF token', async () => {
    const response = await PATCH(jsonRequest('/api/auth/oidc/clients/cli_target', {
      name: 'x', operator: 'y', redirectUris: ['https://service.example/cb'], scopes: ['openid'], webOrigins: [],
    }, { origin: 'https://evil.example' }), context);
    expect(response.status).toBe(403);
    expect(vi.mocked(updateOidcClient)).not.toHaveBeenCalled();
  });

  it('surfaces validation failures without leaking internals', async () => {
    const { ClientValidationError } = await import('@/lib/oidc/client-validation');
    vi.mocked(updateOidcClient).mockRejectedValue(new ClientValidationError(['リダイレクト URI は https が必要です']));
    const response = await PATCH(jsonRequest('/api/auth/oidc/clients/cli_target', {
      name: 'x', operator: 'y', redirectUris: ['http://evil.example/cb'], scopes: ['openid'], webOrigins: [],
    }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('https');
  });

  it('never returns the plaintext secret on creation to a client that is not stored', async () => {
    vi.mocked(createOidcClient).mockResolvedValue({ clientId: 'cli_new', clientSecret: 'sec_once' });
    const response = await createClientRoute(jsonRequest('/api/auth/oidc/clients', {
      name: 'App', operator: 'Op', clientType: 'confidential',
      redirectUris: ['https://service.example/cb'], scopes: ['openid'], webOrigins: [],
    }, { method: 'POST' }), context);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.clientId).toBe('cli_new');
    expect(body.data.clientSecret).toBe('sec_once');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('requires the manually registered test redirect URI before starting a connection test', async () => {
    const { requireManageableClient } = await import('@/lib/oidc/clients');
    vi.mocked(requireManageableClient).mockResolvedValue({
      clientId: 'cli_target', clientType: 'confidential',
      allowedScopes: ['openid'], redirectUris: ['https://service.example/cb'], ownerUserId: 'usr_owner',
    });
    const response = await startTest(jsonRequest('/api/auth/oidc/clients/cli_target/test/start', {
      client_secret: 'sec_plain',
    }, { method: 'POST' }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('/settings/applications/test/callback');
  });

  it('requires the client secret for confidential clients before starting a connection test', async () => {
    const { requireManageableClient } = await import('@/lib/oidc/clients');
    vi.mocked(requireManageableClient).mockResolvedValue({
      clientId: 'cli_target', clientType: 'confidential',
      allowedScopes: ['openid'],
      redirectUris: ['http://localhost:3000/settings/applications/test/callback'],
      ownerUserId: 'usr_owner',
    });
    const response = await startTest(jsonRequest('/api/auth/oidc/clients/cli_target/test/start', {}, { method: 'POST' }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('client secret');
  });
});
