import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { oauthStates } from '@/lib/db/schema';
import { GET } from '@/app/api/auth/oauth/[provider]/route';
import { sha256Hex } from '@/lib/util/crypto';

/**
 * レート制限は rate-limit.test.ts の責務。ここでは常に許可して、
 * 認可リクエストのパラメータだけに集中する（他のテストと IP を共有するため、
 * 実制限をそのまま使うと実行順で flaky になる）。
 */
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: async () => ({ allowed: true, logRateLimited: false, resetAt: Date.now() + 60_000 }),
    reserveFailedAttempt: async () => ({ allowed: true }),
    releaseReservation: async () => undefined,
    finishFailedAttempt: async () => false,
  },
}));

const FULL_ENV = {
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-id',
  GITHUB_CLIENT_SECRET: 'github-secret',
  DISCORD_CLIENT_ID: 'discord-id',
  DISCORD_CLIENT_SECRET: 'discord-secret',
};

const issuedStates: string[] = [];

function request(provider: string, search = '', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://evil.example/api/auth/oauth/${provider}${search}`, {
    method: 'GET',
    headers: { host: 'evil.example', origin: 'http://evil.example', ...headers },
  });
}

async function start(provider: string, search = ''): Promise<Response> {
  const response = await GET(request(provider, search), {
    params: Promise.resolve({ provider }),
  });
  const state = await extractState(response);
  if (state) issuedStates.push(state);
  return response;
}

async function extractState(response: Response): Promise<string | null> {
  const location = response.headers.get('location');
  if (!location) return null;
  return new URL(location).searchParams.get('state');
}

beforeEach(() => {
  for (const [key, value] of Object.entries(FULL_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const db = getDb();
  for (const state of issuedStates.splice(0)) {
    await db.delete(oauthStates).where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
  }
});

/** §9.3: PKCE は S256 固定。plain を許さない。 */
describe('Security - OAuth authorize request (PKCE)', () => {
  it('redirects with 303 and never caches', async () => {
    const response = await start('google');
    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('pins code_challenge_method=S256 and sends a state, nonce and challenge', async () => {
    const response = await start('google');
    const url = new URL(response.headers.get('location')!);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    // D-06: refresh token を求めない
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('scope')).not.toContain('offline_access');
  });

  it('sends no nonce to OAuth2 providers (no OIDC to bind)', async () => {
    const url = new URL((await start('github')).headers.get('location')!);
    expect(url.searchParams.get('nonce')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('stores a code_verifier that matches the sent challenge', async () => {
    const response = await start('github');
    const url = new URL(response.headers.get('location')!);
    const state = url.searchParams.get('state')!;

    const [row] = await getDb().select().from(oauthStates);
    expect(row).toBeDefined();

    const verifier = row!.codeVerifier;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = Buffer.from(sha256Hex(verifier), 'hex').toString('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(state).not.toBe(verifier);
  });
});

/** D-31-01: redirect_uri は env から組み立て、Host ヘッダに依存しない。 */
describe('Security - OAuth redirect_uri', () => {
  it('builds the redirect_uri from NEXT_PUBLIC_APP_URL even when Host is spoofed', async () => {
    const url = new URL((await start('google')).headers.get('location')!);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/auth/oauth/google/callback',
    );
    expect(url.searchParams.get('redirect_uri')).not.toContain('evil.example');
  });

  it('never sends a client_secret to the authorize endpoint', async () => {
    const url = new URL((await start('github')).headers.get('location')!);
    expect(url.search).not.toContain('github-secret');
    expect(url.search).not.toContain('client_secret');
  });

  it('returns 404 INVALID_PROVIDER for an unknown provider', async () => {
    const response = await start('facebook');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_PROVIDER');
  });

  it('returns the same 404 when the provider is registered but not configured', async () => {
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    const response = await start('google');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_PROVIDER');
  });
});

/** `redirect_to` は同一オリジンの相対パスだけ（open redirect 対策）。 */
describe('Security - OAuth redirect_to', () => {
  it('stores a relative path as-is', async () => {
    await start('google', '?redirect_to=%2Fsettings%2Fappearance');
    const [row] = await getDb().select().from(oauthStates);
    expect(row!.redirectTo).toBe('/settings/appearance');
  });

  it('drops an absolute redirect_to before it reaches the database', async () => {
    await start('google', '?redirect_to=https%3A%2F%2Fevil.example%2Fsteal');
    const [row] = await getDb().select().from(oauthStates);
    expect(row!.redirectTo).toBeNull();
  });
});