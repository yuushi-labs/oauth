// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { deriveCsrfToken } from '@/lib/auth/pipeline';

/**
 * 仕様 §24: アカウント削除時は「全セッション無効化・OAuth 連携無効化・**Passkey 無効化**・
 * API アクセス無効化」を行う。Phase 6 で Passkey を導入したため、削除フローが
 * `deleteCredentialsByUser` を呼び忘れると §24 に違反する（回帰ガード）。
 *
 * Route Handler（`DELETE /api/auth/account`）が `deleteCredentialsByUser` を呼ぶことを固定する。
 * 実 PostgreSQL での削除挙動は `account-delete-passkey-db.test.ts` が確認する。
 */

const appUrl = 'http://localhost:3000';

const session = {
  id: 'ses_current', userId: 'usr_owner', sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: 'vitest', ip: '203.0.113.10', ipMasked: '203.0.113.xxx', ipHash: 'iphash-owner',
  deviceName: 'Chrome', reauthVerifiedAt: new Date(), totpPending: false,
};

const { deleteCredentialsMock } = vi.hoisted(() => ({
  deleteCredentialsMock: vi.fn(async () => 1),
}));

vi.mock('next/headers', () => {
  const store = new Map<string, string>();
  return {
    cookies: async () => ({
      get: (name: string) => (store.has(name) ? { name, value: store.get(name) } : undefined),
      set: (name: string, value: string) => void store.set(name, value),
      delete: (name: string) => void store.delete(name),
    }),
  };
});
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => session), revokeAllSessions: vi.fn(async () => undefined) };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: { check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })) },
}));
vi.mock('@/lib/auth/security-events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/reauth', async () => {
  const actual = await vi.importActual('@/lib/auth/reauth');
  return { ...actual, checkReauth: vi.fn(() => undefined) };
});
vi.mock('@/lib/db/queries/users', () => ({
  findUserById: vi.fn(async () => ({ id: 'usr_owner', email: 'owner@example.com', passwordHash: 'hashed' })),
  softDeleteUser: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db/queries/tokens', () => ({ invalidateAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('@/lib/oidc/grants', () => ({ revokeUserOidcGrants: vi.fn(async () => []) }));
vi.mock('@/lib/auth/email/templates', () => ({ sendAccountDeletionEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/queries/webauthn', () => ({ deleteCredentialsByUser: deleteCredentialsMock }));

import { DELETE as deleteAccount } from '@/app/api/auth/account/route';

function request(): NextRequest {
  return new NextRequest(new Request(`${appUrl}/api/auth/account`, {
    method: 'DELETE',
    headers: {
      origin: appUrl,
      'x-csrf-token': deriveCsrfToken(session),
      cookie: 'auth_session=test-token',
      'user-agent': 'vitest',
    },
  }));
}

describe('Security - アカウント削除で Passkey を無効化（仕様 §24 / #19）', () => {
  it('DELETE /api/auth/account が deleteCredentialsByUser を呼ぶ', async () => {
    const response = await deleteAccount(request());
    expect(response.status).toBe(200);
    expect(deleteCredentialsMock).toHaveBeenCalledWith(session.userId);
  });
});
