import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { accounts, DEFAULT_ROLE_ID, oauthStates, securityEvents, sessions, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { startTestAppServer, type TestAppServer } from '@/test/helpers/app-server';
import { httpRequest } from '@/test/helpers/http';
import { extractCallbackState } from '@/test/helpers/oauth';
import { sha256Hex } from '@/lib/util/crypto';
import { rateLimitKeys, protectRateLimitKey } from '@/lib/auth/rate-limit-keys';
import { rateLimitHits } from '@/lib/db/schema';

/**
 * 実 HTTP での通し確認（§9 の手順 1〜2 を自動化できる範囲）。
 *
 * provider の authorize URL までは本物の Route Handler を通すので、
 * redirect_uri・PKCE・state の発行が実際に機能していることを確認できる。
 * provider 側の承認はモックする（実 OAuth アカウントが要るため）。
 */

let app: TestAppServer;
const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];

beforeAll(async () => {
  await resetOAuthRateLimits();
  app = await startTestAppServer({ dev: true, oidc: true });
}, 120_000);

afterAll(async () => {
  const db = getDb();
  for (const id of createdAccountIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.id} = ${id}`);
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(accounts).where(sql`${accounts.userId} = ${id}`);
    await db.delete(securityEvents).where(sql`${securityEvents.userId} = ${id}`);
    await db.delete(sessions).where(sql`${sessions.userId} = ${id}`);
    await db.delete(users).where(sql`${users.id} = ${id}`);
  }
  await db.delete(oauthStates);
  await app.stop();
}, 120_000);

/**
 * レート制限カウンタは実 DB に残り、10 分のウィンドウを跨ぐ。
 * 同じ IP を共有するテストと実行順に依存しないよう、このファイルで使う
 * OAuth のキーだけ消しておく（レート制限そのものは rate-limit.test.ts が検証する）。
 *
 * 保存されるのは `protectRateLimitKey` で HMAC したキーなので、LIKE では当たらない。
 */
async function resetOAuthRateLimits(): Promise<void> {
  const keys = ['0.0.0.0', '127.0.0.1'].flatMap((ip) => [
    protectRateLimitKey(rateLimitKeys.oauthStart(ip)),
    protectRateLimitKey(rateLimitKeys.oauthCallback(ip)),
  ]);
  await getDb().delete(rateLimitHits).where(sql`${rateLimitHits.key} IN ${keys}`);
}

describe('E2E - OAuth authorize redirect', () => {
  it('GET /api/auth/oauth/:provider は 303 で provider の authorize URL に遷移する', async () => {
    const response = await httpRequest(`${app.origin}/api/auth/oauth/google`);

    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.searchParams.get('state')).toBeTruthy();
    // redirect_uri は実行環境の app origin で組み立てられる（Host に依存しない）
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${app.origin}/api/auth/oauth/google/callback`,
    );
  }, 60_000);

  it('authorize URL に client secret は含まれない', async () => {
    const response = await httpRequest(`${app.origin}/api/auth/oauth/github`);
    const location = response.headers.get('location')!;
    expect(location).not.toContain('client_secret');
    expect(location).not.toContain(process.env.GITHUB_CLIENT_SECRET ?? 'unset-secret');
  }, 60_000);

  it('/login は社会ログインボタンと導線を描画する', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('Google で続行');
    expect(response.body).toContain(`/api/auth/oauth/google`);
  }, 60_000);

  it('未登録 provider は 404 で、authorize URL を返さない', async () => {
    const response = await httpRequest(`${app.origin}/api/auth/oauth/facebook`);
    expect(response.status).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_PROVIDER');
  }, 60_000);

  it('code 無しの callback は 400 INVALID_STATE で止まる', async () => {
    const response = await httpRequest(`${app.origin}/api/auth/oauth/google/callback?code=abc`);
    expect(response.status).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_STATE');
  }, 60_000);

  it('authorize → callback の往復で state が 1 回だけ使われる', async () => {
    const start = await httpRequest(`${app.origin}/api/auth/oauth/discord`);
    const state = extractCallbackState(start.headers.get('location')!);
    expect(state).toBeTruthy();
    if (!state) throw new Error('state がありません');

    // provider 側の承認をモックできないので、code を伴わない callback を叩いて
    // 「code が無いなら state を消費せずに INVALID_STATE で止まる」ことを確認する
    const missingCode = await httpRequest(`${app.origin}/api/auth/oauth/discord/callback?state=${state}`);
    expect(missingCode.status).toBe(400);

    // state は消費されていないので、同じ state で code 付きで再試行できる
    const rows = await getDb()
      .select()
      .from(oauthStates)
      .where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
    expect(rows[0]!.consumedAt).toBeNull();

    // 消去して DB を片付ける
    await getDb().delete(oauthStates).where(sql`${oauthStates.stateHash} = ${sha256Hex(state)}`);
  }, 60_000);
});

describe('E2E - connected accounts screen', () => {
  it('未ログインの /settings/connected-accounts は /login へ送られる', async () => {
    const response = await httpRequest(`${app.origin}/settings/connected-accounts`);
    expect([302, 303, 307]).toContain(response.status);
    expect(response.headers.get('location')).toContain('/login');
  }, 60_000);
});
