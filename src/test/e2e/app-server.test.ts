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
    expect(response.headers.get('cache-control')).toContain('no-store');
  }, 60_000);

  it('メール確認・再設定の画面は廃止され 404（D-40-04）', async () => {
    for (const path of [
      '/forgot-password',
      '/reset-password?token=dummy-token',
      '/verify-email',
      '/email-change/confirm?token=dummy-token',
    ]) {
      const response = await httpRequest(`${app.origin}${path}`);
      expect(response.status, `${path} は存在しない`).toBe(404);
    }
  }, 60_000);
});