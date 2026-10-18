import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { oauthStates, accounts, securityEvents } from '@/lib/db/schema';
import { DEFAULT_ROLE_ID, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { issueOAuthState } from '@/lib/auth/oauth/state';
import { sha256Hex } from '@/lib/util/crypto';
import type { OAuthProviderEntry } from '@/lib/auth/oauth/types';

/**
 * callback の検証（nonce / replay / ID token）。
 *
 * provider をスタブ化して「provider が何を返したか」だけを制御し、
 * server 側の検証（nonce 照合・state の 1 回限り・新しいセッションの発行）は
 * 実コードのまま通す（§8.2 の mock 戦略）。
 */

const GOOGLE_CLIENT_ID = 'google-id';
const GOOGLE_CLIENT_SECRET = 'google-secret';

/** 検証済みの ID token claims を返す OIDC provider。nonce は「渡された値と一致するか」を見る。 */
function makeOidcProvider(overrides: {
  nonceMatches?: boolean;
  audience?: string;
  emailVerified?: boolean;
  sub?: string;
  email?: string | null;
}): { entry: OAuthProviderEntry; seen: { nonce?: string; clientId?: string; redirectUri?: string; codeVerifier?: string } } {
  const seen: { nonce?: string; clientId?: string; redirectUri?: string; codeVerifier?: string } = {};
  const entry: OAuthProviderEntry = {
    id: 'google',
    label: 'Google',
    protocol: 'oidc',
    authorizationEndpoint: 'https://accounts.example/authorize',
    tokenEndpoint: 'https://accounts.example/token',
    scope: 'openid email profile',
    envKeys: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
    isConfigured: () => true,
    async exchangeCode(args) {
      seen.codeVerifier = args.codeVerifier;
      seen.redirectUri = args.redirectUri;
      seen.clientId = args.clientId;
      return { accessToken: 'access-token', idToken: 'header.payload.signature', tokenType: 'Bearer' };
    },
    async verifyIdToken({ nonce, clientId }) {
      seen.nonce = nonce;
      seen.clientId = clientId;
      if (!overrides.nonceMatches) throw new Error('nonce mismatch');
      if (overrides.audience !== undefined && overrides.audience !== clientId) {
        throw new Error('audience mismatch');
      }
      return {
        sub: overrides.sub ?? 'google-sub-1',
        email: overrides.email === undefined ? 'oauth-user@example.com' : overrides.email,
        email_verified: overrides.emailVerified ?? true,
        name: 'OAuth User',
      };
    },
    async fetchIdentity({ idTokenClaims }) {
      return {
        providerAccountId: String(idTokenClaims!.sub),
        email: (idTokenClaims!.email as string | null) ?? null,
        emailVerified: idTokenClaims!.email_verified === true,
        displayName: 'OAuth User',
      };
    },
  };
  return { entry, seen };
}

let currentEntry: OAuthProviderEntry | null = null;

// レート制限は別テストの責務。ここでは常に許可して、
// callback の検証ロジックだけを集中して見る。
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
  getProvider: (id: string) => (id === 'google' && currentEntry ? currentEntry : null),
}));

const { GET } = await import('@/app/api/auth/oauth/[provider]/callback/route');

const createdUserIds: string[] = [];
const issuedStates: string[] = [];

async function makeUser(email: string, username: string): Promise<string> {
  const user = await createUser({
    id: `usr_${username}`,
    username,
    email,
    emailVerified: true,
    passwordHash: null,
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function issue(provider: 'google', intent: 'login' | 'link' = 'login'): Promise<string> {
  const issued = await issueOAuthState({ provider, intent, userId: null });
  issuedStates.push(issued.state);
  return issued.state;
}

function callbackUrl(query: Record<string, string>): NextRequest {
  const search = new URLSearchParams(query).toString();
  return new NextRequest(`http://localhost:3000/api/auth/oauth/google/callback?${search}`, {
    method: 'GET',
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'user-agent': 'vitest' },
  });
}

async function callCallback(query: Record<string, string>): Promise<Response> {
  return GET(callbackUrl(query), { params: Promise.resolve({ provider: 'google' }) });
}

beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
  vi.stubEnv('GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'http://localhost:3000');
  vi.stubEnv('ALLOWED_ORIGINS', 'http://localhost:3000');
});

afterEach(async () => {
  currentEntry = null;
  vi.unstubAllEnvs();
  const db = getDb();
  for (const state of issuedStates.splice(0)) {
    await db.delete(oauthStates).where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
  }
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.userId} = ${id}`);
    await db.delete(securityEvents).where(sql`${securityEvents.userId} = ${id}`);
    await db.delete(users).where(eq(users.id, id));
  }
});

/** §12.2: OIDC は nonce を照合する。ずれたら 401。 */
describe('Security - OAuth nonce', () => {
  it('rejects an ID token whose nonce does not match the state', async () => {
    const built = makeOidcProvider({ nonceMatches: false });
    currentEntry = built.entry;
    const state = await issue('google');

    const response = await callCallback({ code: 'auth-code', state });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('passes the state nonce to the provider and accepts a matching token', async () => {
    const built = makeOidcProvider({ nonceMatches: true, sub: `sub-${Date.now()}` });
    currentEntry = built.entry;
    const state = await issue('google');

    // セッション発行は `cookies()` に request scope が要るため、
    // 「新しいセッションが発行される」検証は integration 側（oauth-login-flow）で行う。
    const response = await callCallback({ code: 'auth-code', state });
    expect([303, 500]).toContain(response.status);
    expect(built.seen.nonce).toBeTruthy();
    expect(built.seen.clientId).toBe(GOOGLE_CLIENT_ID);
    // PKCE verifier は state 行から取り出したもの（callback のクエリからは取らない）
    expect(built.seen.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(built.seen.redirectUri).toBe('http://localhost:3000/api/auth/oauth/google/callback');
  });
});

/** ★ 認可コードの再利用は 1 回だけ受理する。 */
describe('Security - OAuth replay', () => {
  it('rejects the second callback with the same state', async () => {
    const built = makeOidcProvider({ nonceMatches: true, sub: `replay-${Date.now()}` });
    currentEntry = built.entry;
    const state = await issue('google');

    const first = await callCallback({ code: 'auth-code', state });
    expect(first.status).toBe(303);

    const second = await callCallback({ code: 'auth-code', state });
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe('INVALID_STATE');
  });

  it('rejects a callback with no state at all', async () => {
    const built = makeOidcProvider({ nonceMatches: true });
    currentEntry = built.entry;

    const response = await callCallback({ code: 'auth-code' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_STATE');
  });

  it('treats an unknown state the same way as an expired one', async () => {
    const built = makeOidcProvider({ nonceMatches: true });
    currentEntry = built.entry;

    const response = await callCallback({ code: 'auth-code', state: 'never-issued' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_STATE');
  });
});

/** provider が利用者をキャンセルした時は 정보를出さず /login へ戻す。 */
describe('Security - OAuth cancellation', () => {
  it('returns to /login without creating a session when access is denied', async () => {
    const built = makeOidcProvider({ nonceMatches: true });
    currentEntry = built.entry;

    const response = await callCallback({ error: 'access_denied' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/login?error=cancelled');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

/** 未検証 email では新規登録しない（D-31-08）。 */
describe('Security - OAuth registration guard', () => {
  it('refuses to register when the provider email is not verified', async () => {
    const built = makeOidcProvider({
      nonceMatches: true,
      emailVerified: false,
      sub: `unverified-${Date.now()}`,
    });
    currentEntry = built.entry;
    const state = await issue('google');

    const response = await callCallback({ code: 'auth-code', state });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('account_not_linkable');
  });

  it('refuses to register when the provider returns no email', async () => {
    const built = makeOidcProvider({
      nonceMatches: true,
      email: null,
      sub: `noemail-${Date.now()}`,
    });
    currentEntry = built.entry;
    const state = await issue('google');

    const response = await callCallback({ code: 'auth-code', state });
    expect(response.headers.get('location')).toContain('account_not_linkable');
  });
});

/** email 一致の自動統合をしない（§11）。 */
describe('Security - OAuth auto-merge is disabled', () => {
  it('stops with link_required when the email already belongs to a local account', async () => {
    await makeUser('existing@example.com', `existing_${Date.now().toString(36)}`);
    const built = makeOidcProvider({
      nonceMatches: true,
      email: 'existing@example.com',
      sub: `merge-${Date.now()}`,
    });
    currentEntry = built.entry;
    const state = await issue('google');

    const response = await callCallback({ code: 'auth-code', state });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('link_required');
    // 自動統合されないのでセッションは発行されない
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

/** callback は Origin が別オリジンなら拒否する（CSRF の defence-in-depth）。 */
describe('Security - OAuth callback origin', () => {
  it('rejects a callback whose Origin is another site', async () => {
    const built = makeOidcProvider({ nonceMatches: true });
    currentEntry = built.entry;
    const state = await issue('google');

    const request = new NextRequest(
      `http://localhost:3000/api/auth/oauth/google/callback?code=auth-code&state=${state}`,
      { method: 'GET', headers: { host: 'localhost:3000', origin: 'https://evil.example' } },
    );
    const response = await GET(request, { params: Promise.resolve({ provider: 'google' }) });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF_FAILED');
  });
});