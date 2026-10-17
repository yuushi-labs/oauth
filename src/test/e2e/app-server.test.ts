// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestAppServer } from '../helpers/app-server';
import { httpRequest } from '../helpers/http';

/**
 * BUG-7: Route Handlers and screens had no real-HTTP test path, so cookies, 303 redirects
 * and Cache-Control could not be asserted. This boots the same server `pnpm dev` uses.
 */
let app: Awaited<ReturnType<typeof startTestAppServer>>;

beforeAll(async () => {
  // Next loads .env during app.prepare(), which re-adds OIDC_ISSUER, so the issuer has to
  // match this server's origin instead of being switched off.
  app = await startTestAppServer({ dev: true, oidc: true });
}, 120_000);

afterAll(async () => {
  if (app) await app.stop();
});

describe('E2E - real HTTP against the Next server (BUG-7)', () => {
  it('GET /login が 200 を返し HTML を返す', async () => {
    const response = await httpRequest(`${app.origin}/login`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('<!DOCTYPE html>');
  }, 60_000);

  it('token 付きのリセット URL は 200（BUG-1 の画面が存在する）', async () => {
    const response = await httpRequest(`${app.origin}/reset-password?token=dummy-token`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
  }, 60_000);

  it('email 変更確認画面が 200（BUG-2 の画面が存在する）', async () => {
    const response = await httpRequest(`${app.origin}/email-change/confirm?token=dummy-token`);
    expect(response.status).toBe(200);
  }, 60_000);

  it('forgot 画面が 200', async () => {
    const response = await httpRequest(`${app.origin}/forgot-password`);
    expect(response.status).toBe(200);
  }, 60_000);

  it('GET /api/auth/email/change/confirm は画面へ 303 転送する（BUG-2）', async () => {
    const response = await httpRequest(`${app.origin}/api/auth/email/change/confirm?token=dummy-token`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/email-change/confirm');
  }, 60_000);
});