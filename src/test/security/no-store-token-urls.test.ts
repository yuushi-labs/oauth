// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const appUrl = 'http://localhost:3000';

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
vi.mock('@/lib/auth/security-events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/queries/tokens', () => ({
  markEmailChangeNotified: vi.fn(async () => undefined),
  invalidateEmailVerificationTokens: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/email/templates', () => ({
  sendChangeNotificationEmail: vi.fn(async () => undefined),
  sendVerificationEmail: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/tokens/verify', () => ({
  verifyAndConsumeToken: vi.fn(async () => ({ valid: true, userId: 'usr_1', newEmail: 'new@example.com' })),
}));

import { middleware } from '@/middleware';

/** 仕様書 §25 / §45: 認証系・設定画面は共有キャッシュに残さない。
 *  メール確認・再設定・メール変更の画面は廃止したため、token を載せる URL はもう存在しない（D-40-04）。 */
describe('Security - auth and settings screens are not cacheable', () => {
  const paths = ['/login', '/register', '/settings'];

  it.each(paths)('%s は Cache-Control: no-store', (path) => {
    const request = new NextRequest(new Request(`${appUrl}${path}`, { headers: { host: 'localhost:3000' } }));
    const response = middleware(request);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('静的アセット以外は対象外のまま', () => {
    const request = new NextRequest(new Request(`${appUrl}/`, { headers: { host: 'localhost:3000' } }));
    // The root page is the logged-in hub; it is not part of the no-store set.
    expect(middleware(request).headers.get('Cache-Control')).toBeNull();
  });
});