import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { accounts, DEFAULT_ROLE_ID, oauthStates, securityEvents, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { createAccount } from '@/lib/auth/oauth/accounts';
import { issueOAuthState } from '@/lib/auth/oauth/state';
import { sha256Hex } from '@/lib/util/crypto';
import type { OAuthProviderEntry } from '@/lib/auth/oauth/types';

/**
 * Aikido Issue #2: callback の open redirect 対策。
 *
 * `redirect_to` は「同一オリジンの相対パス」だけを受理する。
 * 保存時（`issueOAuthState`）に加えて、DB から読み出した後のリダイレクト直前でも
 * 検証していることを、実際の callback ハンドラ通しで固定する。
 * ここでは「正規化が入る前に書かれた行」を UPDATE で再現し、値が細工されていても
 * 外部オリジンへは飛ばないことを確かめる（保存時だけの防御に依存しない）。
 */

const GOOGLE_CLIENT_ID = 'google-id';
const GOOGLE_CLIENT_SECRET = 'google-secret';

/** 紐付き済みアカウントとしてログインさせる provider（ID token は常に一致扱い）。 */
const providerSub = `open-redirect-sub-${Date.now()}`;

const provider: OAuthProviderEntry = {
  id: 'google',
  label: 'Google',
  protocol: 'oidc',
  authorizationEndpoint: 'https://accounts.example/authorize',
  tokenEndpoint: 'https://accounts.example/token',
  scope: 'openid email profile',
  envKeys: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  isConfigured: () => true,
  async exchangeCode() {
    return { accessToken: 'access-token', idToken: 'header.payload.signature', tokenType: 'Bearer' };
  },
  async verifyIdToken() {
    return { sub: providerSub, email: null, email_verified: false, name: 'Redirect User' };
  },
  async fetchIdentity() {
    return { providerAccountId: providerSub, email: null, emailVerified: false, displayName: 'Redirect User' };
  },
};

// レート制限は別テストの責務。ここでは常に許可する（callback の遷移だけを見る）。
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: async () => ({ allowed: true, logRateLimited: false, resetAt: Date.now() + 60_000 }),
    reserveFailedAttempt: async () => ({ allowed: true }),
    releaseReservation: async () => undefined,
    finishFailedAttempt: async () => false,
  },
}));

vi.mock('@/lib/auth/oauth/registry', () => ({
  OAUTH_PROVIDER_REGISTRY: [],
  oauthEnvKeys: () => ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  isEmptyRegistry: () => false,
  configuredOAuthProviders: () => [],
  getProvider: (id: string) => (id === 'google' ? provider : null),
}));

// セッション/匿名 Cookie の書き込みは `next/headers` のリクエストスコープを要求する。
// ここではハンドラを直接呼ぶため、書き込みだけを no-op にする（Cookie の組み立て自体は
// cookie.test.ts の責務）。ログイン成功時の遷移先だけを確かめる。
vi.mock('@/lib/auth/cookie', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/cookie')>();
  return {
    ...actual,
    setSessionCookie: async () => undefined,
    setAnonCookie: async () => undefined,
  };
});

const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route');

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const issuedStates: string[] = [];

async function makeLinkedUser(): Promise<string> {
  const user = await createUser({
    id: `usr_openredir_${createdUserIds.length}_${Date.now().toString(36)}`,
    username: `openredir_${createdUserIds.length}_${Date.now().toString(36)}`,
    email: `open-redirect-${createdUserIds.length}-${Date.now().toString(36)}@example.com`,
    emailVerified: true,
    passwordHash: null,
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(user.id);
  const account = await createAccount({
    userId: user.id,
    provider: 'google',
    providerAccountId: providerSub,
    providerEmail: null,
  });
  createdAccountIds.push(account.id);
  return user.id;
}

/**
 * state 行を作り、`redirect_to` を「正規化が入る前の汚れた値」に書き換える。
 * 攻撃者が細工した値、あるいは正規化導入前から残っている行を再現する。
 */
async function issueStateWithStoredRedirectTo(stored: string | null): Promise<string> {
  const issued = await issueOAuthState({ provider: 'google', intent: 'login', redirectTo: null });
  issuedStates.push(issued.state);
  if (stored !== null) {
    await getDb()
      .update(oauthStates)
      .set({ redirectTo: stored })
      .where(eq(oauthStates.stateHash, sha256Hex(issued.state)));
  }
  return issued.state;
}

async function callCallback(state: string): Promise<Response> {
  const url = `http://localhost:3000/api/auth/oauth/google/callback?${new URLSearchParams({ code: 'auth-code', state })}`;
  return GET(
    new NextRequest(url, {
      method: 'GET',
      headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'user-agent': 'vitest' },
    }),
    { params: Promise.resolve({ provider: 'google' }) },
  );
}

beforeEach(async () => {
  vi.stubEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
  vi.stubEnv('GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'http://localhost:3000');
  vi.stubEnv('ALLOWED_ORIGINS', 'http://localhost:3000');
  if (createdUserIds.length === 0) await makeLinkedUser();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const db = getDb();
  for (const state of issuedStates.splice(0)) {
    await db.delete(oauthStates).where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
  }
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(eq(accounts.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(securityEvents).where(eq(securityEvents.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - OAuth callback open redirect (Aikido Issue #2)', () => {
  it('redirects to the same-origin path that was stored', async () => {
    const state = await issueStateWithStoredRedirectTo('/settings/appearance');
    const response = await callCallback(state);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/settings/appearance');
  });

  it('falls back to / when the stored value is an absolute URL', async () => {
    const state = await issueStateWithStoredRedirectTo('https://evil.example/steal');
    const response = await callCallback(state);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(response.headers.get('location')).not.toContain('evil.example');
  });

  it('falls back to / for protocol-relative and backslash tricks', async () => {
    for (const stored of ['//evil.example/steal', '/\\evil.example/steal', 'javascript:alert(1)']) {
      const state = await issueStateWithStoredRedirectTo(stored);
      const response = await callCallback(state);

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('http://localhost:3000/');
    }
  });

  it('falls back to / when no redirect_to was recorded', async () => {
    const state = await issueStateWithStoredRedirectTo(null);
    const response = await callCallback(state);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
  });
});
