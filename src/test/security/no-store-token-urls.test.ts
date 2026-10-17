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

/** 仕様書 §25 / §45: token-bearing screens were cacheable, so a shared/proxy cache could retain the
 *  verification, password-reset or email-change token. */
describe('Security - token-bearing screens are not cacheable', () => {
  const paths = [
    '/verify-email',
    '/forgot-password',
    '/reset-password?token=secret-token-value',
    '/email-change/confirm?token=secret-token-value',
    '/login',
    '/register',
    '/settings',
  ];

  it.each(paths)('%s は Cache-Control: no-store', (path) => {
    const request = new NextRequest(new Request(`${appUrl}${path}`, { headers: { host: 'localhost:3000' } }));
    const response = middleware(request);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('静的アセット以外は対象外のまま', () => {
    const request = new NextRequest(new Request(`${appUrl}/`, { headers: { host: 'localhost:3000' } }));
    // The root page is the logged-in hub; it is not part of the token-bearing set.
    expect(middleware(request).headers.get('Cache-Control')).toBeNull();
  });
});

describe('Security - confirm-email GET does not mutate (spec 25)', () => {
  it('GET /api/auth/email/change/confirm は 303 で画面へ促すだけ', async () => {
    const { GET } = await import('@/app/api/auth/email/change/confirm/route');
    const request = new NextRequest(new Request(`${appUrl}/api/auth/email/change/confirm?token=abc`, {
      headers: { origin: appUrl },
    }));
    const response = await GET(request);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/email-change/confirm');
  });

});