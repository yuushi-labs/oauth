// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { deriveCsrfToken } from '@/lib/auth/pipeline';

/**
 * BUG-6 / 仕様書 §18・§45・§46: 通知メール送信は best-effort。
 *
 * 送信に失敗しても呼び出し元の応答は成功時と同一に保たなければならない。直接 await すると
 * 送信失敗で 500 になり、「操作は成功したのにエラー表示」という不整合が起きる
 * （password/reset・change・set・account で発生していた）。
 *
 * ここでは Route Handler を通し、メール送信が throw しても 200 が返ることを固定する。
 */

const appUrl = 'http://localhost:3000';

const session = {
  id: 'ses_current', userId: 'usr_owner', sessionHash: 'hash', csrfSecret: 'csrf-secret',
  userAgent: 'vitest', ip: '203.0.113.10', ipMasked: '203.0.113.xxx', ipHash: 'iphash-owner',
  deviceName: 'Chrome', reauthVerifiedAt: new Date(), totpPending: false,
};

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
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual('@/lib/auth/session');
  return { ...actual, getSession: vi.fn(async () => session), revokeAllSessions: vi.fn(async () => undefined) };
});
vi.mock('@/lib/auth/rate-limit', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000, logRateLimited: false })),
    reserveFailedAttempt: vi.fn(async () => ({
      allowed: true,
      reservation: { reservationId: 'res_1', key: 'k', generation: 1, captchaRequired: false, resetAt: Date.now() + 60_000 },
    })),
    finishFailedAttempt: vi.fn(async () => undefined),
  },
}));
vi.mock('@/lib/auth/security-events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
// 削除は強い再認証（パスワード＋コード / Passkey）必須（§8 / §24）。ここでは検証済みとして固定する。
vi.mock('@/lib/auth/strong-reauth', () => ({
  requireStrongReauth: vi.fn(async () => ({ method: 'password' as const })),
}));
vi.mock('@/lib/db/queries/webauthn', () => ({ deleteCredentialsByUser: vi.fn(async () => 0) }));
vi.mock('@/lib/auth/breached', () => ({ checkBreached: vi.fn(async () => ({ breached: false, failOpen: false })) }));
vi.mock('@/lib/auth/password', async () => {
  const actual = await vi.importActual('@/lib/auth/password');
  return { ...actual, verifyPassword: vi.fn(async () => true), hashPassword: vi.fn(async () => 'hashed') };
});
vi.mock('@/lib/db/queries/users', () => ({
  findUserById: vi.fn(async () => ({ id: 'usr_owner', email: 'owner@example.com', passwordHash: 'hashed' })),
  updateUser: vi.fn(async () => undefined),
  softDeleteUser: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db/queries/tokens', () => ({ invalidateAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('@/lib/oidc/grants', () => ({ revokeUserOidcGrants: vi.fn(async () => []) }));

// ★ 通知メール送信は必ず失敗する（vi.mock は巻き上げられるため vi.hoisted で定義）
const { emailBoom } = vi.hoisted(() => ({
  emailBoom: vi.fn(async () => { throw new Error('resend down'); }),
}));
vi.mock('@/lib/auth/email/templates', () => ({
  sendChangeNotificationEmail: emailBoom,
  sendAccountDeletionEmail: emailBoom,
  sendSecurityNotificationEmail: emailBoom,
}));

import { POST as changePassword } from '@/app/api/auth/password/change/route';
import { DELETE as deleteAccount } from '@/app/api/auth/account/route';

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(new Request(`${appUrl}${path}`, {
    method,
    headers: {
      origin: appUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-csrf-token': deriveCsrfToken(session),
      cookie: 'auth_session=test-token',
      'user-agent': 'vitest',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
}

describe('Security - 通知メール送信失敗でも変更系 API は成功応答（BUG-6 / §18）', () => {
  it('password/change: 送信失敗でも 200 を返す（500 にしない）', async () => {
    const response = await changePassword(request('/api/auth/password/change', 'POST', {
      current_password: 'Old-Strong-2026!',
      new_password: 'New-Strong-2026!',
      new_password_confirm: 'New-Strong-2026!',
    }));
    expect(response.status).toBe(200);
    expect(emailBoom).toHaveBeenCalled();
  });

  it('account 削除: 送信失敗でも 200 を返す（500 にしない）', async () => {
    const response = await deleteAccount(request('/api/auth/account', 'DELETE', { code: '123456' }));
    expect(response.status).toBe(200);
    expect(emailBoom).toHaveBeenCalled();
  });
});
