// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestAppServer } from '../helpers/app-server';
import { httpRequest } from '../helpers/http';

/**
 * 実ブラウザ検証で報告された 2 件の回帰防止（2026-10-17）。
 *
 * 1) hydration mismatch: テーマ初期化 script の nonce
 *    ブラウザは nonce を `getAttribute()` で隠す（HTML 仕様）ため React は
 *    「server の値 vs 空文字」を比較して警告する。DOM は正しく、警告は誤検出。
 *    → script 要素に `suppressHydrationWarning` を付け、hydration 時に黙らせる。
 *    併せて nonce が**応答の CSP ヘッダと一致すること**（＝実行が許される）も固定する。
 *
 * 2) favicon の 404
 *    → `src/app/favicon.ico` を app に置くことで /favicon.ico が 200 になる。
 */
let app: Awaited<ReturnType<typeof startTestAppServer>>;

beforeAll(async () => {
  app = await startTestAppServer({ dev: true, oidc: true });
}, 120_000);

afterAll(async () => {
  if (app) await app.stop();
}, 60_000);

describe('E2E - theme init script nonce (hydration)', () => {
  it('script の nonce が CSP ヘッダの nonce と一致する（実行が許可される）', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    const csp = response.headers.get('content-security-policy') ?? '';
    const headerNonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    const scriptNonce = /<script nonce="([^"]*)"[^>]*>\(function\(\)\{try\{var s=/.exec(response.body)?.[1];

    expect(headerNonce).toBeTruthy();
    expect(scriptNonce).toBeTruthy();
    expect(scriptNonce).toBe(headerNonce);
  }, 60_000);

  it('★ suppressHydrationWarning が script に渡されている（RSC payload 経由でクライアントにも届く）', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    // React は suppressHydrationWarning を属性として出力しないため、
    // RSC ペイロード（インライン script 内の props）に含まれることを確認する
    const payloadMarkers = response.body.match(/suppressHydrationWarning/g) ?? [];
    expect(payloadMarkers.length).toBeGreaterThan(0);
  }, 60_000);

  it('CSP はインライン script を nonce + strict-dynamic で許可する', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  }, 60_000);

  it('テーマ初期化 script は描画前に実行され、テーマ適用と localStorage 保存を行う', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    expect(response.body).toContain('document.documentElement.dataset.theme');
    expect(response.body).toContain('localStorage.setItem');
    // ユーザー入力を補間していないこと（enum 3 値のみ）
    expect(response.body).toMatch(/var s="(system|light|dark)"/);
  }, 60_000);
});

describe('E2E - favicon', () => {
  it('/favicon.ico が 200 で image/x-icon を返す（404 が出ない）', async () => {
    const response = await httpRequest(`${app.origin}/favicon.ico`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image');
  }, 60_000);

  it('HTML に icon link が入る', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    expect(response.body).toContain('rel="icon"');
    expect(response.body).toContain('/favicon.ico');
  }, 60_000);
});