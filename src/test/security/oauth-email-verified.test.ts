import { afterEach, describe, expect, it } from 'vitest';
import { github } from '@/lib/auth/oauth/github';
import { discord } from '@/lib/auth/oauth/discord';
import { OAUTH_PROVIDER_REGISTRY, configuredOAuthProviders, getProvider } from '@/lib/auth/oauth/registry';

/**
 * §11.2 / D-31-08: **検証済みの email が取れなければ新規登録させない**。
 * provider を絞らず「登録させない」側に倒す（fail closed）。
 */
describe('Security - OAuth email_verified', () => {
  it('GitHub picks only the primary AND verified address', async () => {
    stubFetch([
      { json: { id: 42, name: 'octo', login: 'octo' } },
      {
        json: [
          { email: 'old@example.com', primary: false, verified: true },
          { email: 'private@example.com', primary: true, verified: false },
          { email: 'main@example.com', primary: true, verified: true },
        ],
      },
    ]);

    const identity = await github.fetchIdentity({ accessToken: 'token' });
    expect(identity.providerAccountId).toBe('42');
    expect(identity.email).toBe('main@example.com');
    expect(identity.emailVerified).toBe(true);
  });

  it('GitHub reports an unverified-only account as not linkable', async () => {
    stubFetch([
      { json: { id: 7, login: 'hidden' } },
      { json: [{ email: 'hidden@example.com', primary: true, verified: false }] },
    ]);

    const identity = await github.fetchIdentity({ accessToken: 'token' });
    // primary && verified の組が無いので email は公開しない（emailVerified も false）
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it('GitHub reports a missing email as null rather than an empty string', async () => {
    stubFetch([{ json: { id: 8, login: 'nomail' } }, { json: [] }]);

    const identity = await github.fetchIdentity({ accessToken: 'token' });
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it('GitHub sends Accept: application/vnd.github+json and a Bearer token', async () => {
    stubFetch([{ json: { id: 9, login: 'x' } }, { json: [] }]);

    await github.fetchIdentity({ accessToken: 'secret-token' });
    for (const call of fetchCalls) {
      expect(call.headers.accept).toBe('application/vnd.github+json');
      expect(call.headers.authorization).toBe('Bearer secret-token');
    }
  });

  it('Discord trusts the email only when verified is true', async () => {
    stubFetch([{ json: { id: '1', username: 'u', email: 'd@example.com', verified: false } }]);
    expect(await discord.fetchIdentity({ accessToken: 't' })).toMatchObject({
      email: 'd@example.com',
      emailVerified: false,
    });
  });

  it('Discord distinguishes a null email from an empty string', async () => {
    stubFetch([{ json: { id: '2', username: 'u', email: '', verified: true } }]);
    const identity = await discord.fetchIdentity({ accessToken: 't' });
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it('Discord rejects a response without an id', async () => {
    stubFetch([{ json: { username: 'u' } }]);
    await expect(discord.fetchIdentity({ accessToken: 't' })).rejects.toThrow();
  });
});

/** isConfigured は client_id と client_secret の両方揃って true（D-31-07）。 */
describe('Security - provider configuration', () => {
  const fullEnv = {
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    DISCORD_CLIENT_ID: 'id',
    DISCORD_CLIENT_SECRET: 'secret',
  };

  it('accepts a fully configured provider and rejects a half-configured one', () => {
    expect(getProvider('google', fullEnv)).not.toBeNull();
    expect(getProvider('google', { GOOGLE_CLIENT_ID: 'id' })).toBeNull();
    expect(getProvider('google', { GOOGLE_CLIENT_SECRET: 'secret' })).toBeNull();
    expect(getProvider('google', {})).toBeNull();
  });

  it('treats an unknown provider and an unconfigured provider identically', () => {
    expect(getProvider('facebook', fullEnv)).toBeNull();
    expect(getProvider('facebook', {})).toBeNull();
    // どちらのケースも同じ 404 に落とす（callback 側の実装とセット）
    expect(getProvider('facebook', fullEnv)).toEqual(getProvider('google', {}));
  });

  it('only lists configured providers in the UI-facing list', () => {
    expect(configuredOAuthProviders(fullEnv)).toHaveLength(3);
    expect(configuredOAuthProviders({ GOOGLE_CLIENT_ID: 'id' })).toHaveLength(0);
  });

  it('never exposes refresh token storage and keeps the registry free of secrets', () => {
    for (const provider of OAUTH_PROVIDER_REGISTRY) {
      // envKeys は「キー名」だけを持つ。値を持たない。
      expect(Object.keys(provider.envKeys).sort()).toEqual(['clientId', 'clientSecret']);
      expect(provider.scope).not.toContain('offline_access');
    }
  });
});

// ---- fetch スタブ ----

type FetchCall = { url: string; headers: Record<string, string> };
const fetchCalls: FetchCall[] = [];
let originalFetch: typeof globalThis.fetch | undefined;

function stubFetch(responses: Array<{ status?: number; json: unknown }>): void {
  fetchCalls.length = 0;
  originalFetch ??= globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const next = responses[index++] ?? { json: {} };
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});