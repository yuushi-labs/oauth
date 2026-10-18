import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  codeChallengeFor,
  consumeOAuthState,
  issueOAuthState,
  normalizeRedirectTo,
} from '@/lib/auth/oauth/state';
import { oauthStates } from '@/lib/db/schema';
import { sha256Hex } from '@/lib/util/crypto';
import { redirectUriFor } from '@/lib/auth/oauth/redirect-uri';

const issued: string[] = [];

async function cleanup(): Promise<void> {
  if (issued.length === 0) return;
  const db = getDb();
  for (const state of issued) {
    await db.delete(oauthStates).where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
  }
  issued.length = 0;
}

afterEach(cleanup);

/**
 * §12.2 / D-31-05: `state` は 1 回限りの消費で、不一致・期限切れ・消費済みは
 * 利用者から見ると同じ「失敗」に落とす。
 */
describe('Security - OAuth state', () => {
  it('issues a state whose row stores only the SHA-256 of the state', async () => {
    const issuedState = await issueOAuthState({ provider: 'google', intent: 'login' });
    issued.push(issuedState.state);

    const [row] = await getDb().select().from(oauthStates);
    expect(row).toBeDefined();
    expect(row!.stateHash).toBe(sha256Hex(issuedState.state));
    // 生 state は保存しない
    expect(JSON.stringify(row)).not.toContain(issuedState.state);
    expect(issuedState.state.length).toBeGreaterThanOrEqual(43);
  });

  it('consumes a valid state exactly once and rejects the replay', async () => {
    const issuedState = await issueOAuthState({ provider: 'github', intent: 'login' });
    issued.push(issuedState.state);

    const first = await consumeOAuthState(issuedState.state, 'github');
    expect(first).not.toBeNull();
    expect(first!.intent).toBe('login');
    expect(first!.codeVerifier).toBe(issuedState.codeVerifier);

    // ★ 2 回目は必ず失敗（認可コードの再利用を DB 側で 1 回限りにしている）
    const second = await consumeOAuthState(issuedState.state, 'github');
    expect(second).toBeNull();
  });

  it('rejects an unknown state', async () => {
    expect(await consumeOAuthState('never-issued-state', 'google')).toBeNull();
  });

  it('rejects a state issued for another provider', async () => {
    const issuedState = await issueOAuthState({ provider: 'google', intent: 'login' });
    issued.push(issuedState.state);

    expect(await consumeOAuthState(issuedState.state, 'github')).toBeNull();
    // provider が一致する側ではまだ消費できる（別 provider での失敗では消費されない）
    expect(await consumeOAuthState(issuedState.state, 'google')).not.toBeNull();
  });

  it('rejects an expired state', async () => {
    const issuedState = await issueOAuthState({ provider: 'discord', intent: 'login' });
    issued.push(issuedState.state);

    await getDb()
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(sql`${oauthStates.stateHash} = ${sha256Hex(issuedState.state)}`);

    expect(await consumeOAuthState(issuedState.state, 'discord')).toBeNull();
  });

  it('keeps intent and user_id for the link flow', async () => {
    const issuedState = await issueOAuthState({
      provider: 'github',
      intent: 'link',
      userId: null,
    });
    issued.push(issuedState.state);

    const consumed = await consumeOAuthState(issuedState.state, 'github');
    expect(consumed!.intent).toBe('link');
    // link でも user_id は state に載せる。callback は現セッションと照合する。
    expect(consumed!.userId).toBeNull();
  });

  it('builds redirect_uri from NEXT_PUBLIC_APP_URL and never from a request Host', () => {
    // setup.ts が NEXT_PUBLIC_APP_URL=http://localhost:3000 を設定済み。
    // Host ヘッダは導出材料に一切含まれない。
    expect(redirectUriFor('google')).toBe('http://localhost:3000/api/auth/oauth/google/callback');
    expect(redirectUriFor('github')).toBe('http://localhost:3000/api/auth/oauth/github/callback');
    expect(redirectUriFor('discord')).not.toContain('evil.example');
  });
});

describe('Security - redirect_to normalization (open redirect)', () => {
  it('keeps a same-origin relative path', () => {
    expect(normalizeRedirectTo('/settings/connected-accounts')).toBe('/settings/connected-accounts');
  });

  it('drops absolute URLs, protocol-relative URLs and backslash tricks', () => {
    expect(normalizeRedirectTo('https://evil.example/x')).toBeNull();
    expect(normalizeRedirectTo('//evil.example/x')).toBeNull();
    expect(normalizeRedirectTo('/\\evil.example')).toBeNull();
    expect(normalizeRedirectTo('settings')).toBeNull();
    expect(normalizeRedirectTo('')).toBeNull();
    expect(normalizeRedirectTo(undefined)).toBeNull();
  });

  it('drops control characters and truncates long values', () => {
    expect(normalizeRedirectTo('/a\u0000b')).toBeNull();
    expect(normalizeRedirectTo(`/${'a'.repeat(300)}`)).toHaveLength(200);
  });
});

describe('Security - PKCE', () => {
  it('derives the code_challenge with S256 and never uses plain', () => {
    const verifier = 'a'.repeat(43);
    const challenge = codeChallengeFor(verifier);
    // S256 = base64url(sha256(verifier)) なので verifier 自身とは一致しない
    expect(challenge).not.toBe(verifier);
    expect(challenge).toBe(codeChallengeFor(verifier));
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});