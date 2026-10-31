// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

const appUrl = 'http://localhost:3000';

vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })),
  },
}));
vi.mock('@/lib/auth/breached', () => ({
  checkBreached: vi.fn(async () => ({ breached: false, failOpen: false })),
}));
vi.mock('@/lib/auth/captcha', () => ({ verifyCaptchaIfRequired: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/queries/users')>('@/lib/db/queries/users');
  return {
    ...actual,
    findUserByLowerEmail: vi.fn(async () => ({ id: 'usr_reset', email: 'reset@example.com' })),
  };
});
vi.mock('@/lib/auth/security-events', () => ({
  recordSecurityEvent: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db/queries/tokens', () => ({
  invalidatePasswordResetTokens: vi.fn(async () => undefined),
  insertPasswordResetToken: vi.fn(async () => undefined),
  invalidateEmailVerificationTokens: vi.fn(async () => undefined),
  insertEmailVerificationToken: vi.fn(async () => undefined),
  invalidateEmailChangeRequests: vi.fn(async () => undefined),
  insertEmailChangeRequest: vi.fn(async () => undefined),
  markEmailChangeNotified: vi.fn(async () => undefined),
}));

import { useMemoryEmail, restoreResendEmail } from '@/test/helpers/email';
import { POST as forgot } from '@/app/api/auth/password/forgot/route';
import { GET as confirmEmailGet } from '@/app/api/auth/email/change/confirm/route';

// Unauthenticated POSTs still go through the shared pipeline, so the anon cookie and its
// matching CSRF token are required. Sign the secret exactly like lib/auth/cookie.ts does.
const anonSecret = 'anon-secret-for-tests';
const anonSigned = createHmac('sha256', process.env.CSRF_SECRET ?? 'c'.repeat(43)).update(anonSecret).digest('hex');
const anonCookieValue = `${anonSecret}.${anonSigned}`;

function post(path: string, body: unknown) {
  return new NextRequest(new Request(`${appUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appUrl,
      cookie: `auth_anon=${anonCookieValue}`,
      'x-csrf-token': anonSecret,
    },
    body: JSON.stringify(body),
  }));
}

let mail: ReturnType<typeof useMemoryEmail>;

beforeEach(() => {
  mail = useMemoryEmail();
});

afterEach(() => {
  restoreResendEmail();
  vi.clearAllMocks();
});

describe('BUG-1 - password reset link points at a real screen', () => {
  it('forgot が送る URL は /reset-password（旧 /password/reset は存在しない）', async () => {
    const response = await forgot(post('/api/auth/password/forgot', { email: 'reset@example.com' }));
    expect(response.status).toBe(200);

    expect(mail.outbox).toHaveLength(1);
    const email = mail.outbox[0]!;
    expect(email.text).toContain('/reset-password?token=');
    expect(email.text).not.toContain('/password/reset');
    expect(email.tokenFromUrl).toBeTruthy();
  });

  it('未知のメールでも同じ 200・同じメッセージを返す（列挙対策）', async () => {
    const { findUserByLowerEmail } = await import('@/lib/db/queries/users');
    vi.mocked(findUserByLowerEmail).mockResolvedValueOnce(null as never);
    const response = await forgot(post('/api/auth/password/forgot', { email: 'nobody@example.com' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.message).toContain('存在する場合');
    expect(mail.outbox).toHaveLength(0);
  });

  it('BUG-6: メール送信が失敗しても 200 と同一メッセージ（列挙攻撃の回帰防止）', async () => {
    mail.failNext();
    const response = await forgot(post('/api/auth/password/forgot', { email: 'reset@example.com' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.message).toContain('存在する場合');

    const { recordSecurityEvent } = await import('@/lib/auth/security-events');
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      'security_notification_failed', 'usr_reset', expect.any(String), expect.any(String),
      { kind: 'password_reset' },
    );
  });
});

describe('BUG-2 - email change confirmation link is reachable', () => {
  it('GET は 303 で /email-change/confirm へ転送する', async () => {
    const request = new NextRequest(new Request(`${appUrl}/api/auth/email/change/confirm?token=abc123`, {
      headers: { origin: appUrl },
    }));
    const response = await confirmEmailGet(request);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/email-change/confirm');
    expect(location.searchParams.get('token')).toBe('abc123');
  });

  it('トークンなしでも 303（画面側で案内を出す）', async () => {
    const request = new NextRequest(new Request(`${appUrl}/api/auth/email/change/confirm`, { headers: { origin: appUrl } }));
    const response = await confirmEmailGet(request);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') ?? '').searchParams.has('token')).toBe(false);
  });
});