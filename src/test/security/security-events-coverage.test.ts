import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dbMock = vi.hoisted(() => ({ values: vi.fn() }));
vi.mock('@/lib/db/client', () => ({
  getDb: () => ({ insert: () => ({ values: dbMock.values }) }),
}));

import { recordSecurityEvent } from '@/lib/auth/security-events';

describe('Phase 2 security event coverage', () => {
  it('records the core Phase 1 authentication events from their endpoint handlers', () => {
    const routeEvents: Array<[string, string[]]> = [
      ['register/route.ts', ['register']],
      ['login/route.ts', ['login_failed', 'login_success']],
      ['logout/route.ts', ['logout']],
      ['verify-email/route.ts', ['email_verified']],
      ['resend-verification/route.ts', ['captcha_challenged', 'rate_limited']],
      ['password/forgot/route.ts', ['captcha_challenged', 'rate_limited']],
      ['password/change/route.ts', ['password_changed']],
      ['password/reset/route.ts', ['password_reset']],
      ['password/set/route.ts', ['password_changed']],
      ['email/change/confirm/route.ts', ['email_changed']],
      ['account/route.ts', ['account_deleted']],
    ];
    for (const [relativePath, eventTypes] of routeEvents) {
      const source = readFileSync(resolve(process.cwd(), 'src/app/api/auth', relativePath), 'utf8');
      for (const eventType of eventTypes) {
        expect(source, `${relativePath} should record security events`).toContain('recordSecurityEvent');
        expect(source, `${relativePath} should record ${eventType}`).toContain(`'${eventType}'`);
      }
    }
  });

  it('stores a masked display IP and passes only caller-supplied contextual metadata', async () => {
    await recordSecurityEvent('rate_limited', null, '203.0.113.42', 'test-agent', { scope: 'login' });
    expect(dbMock.values).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'rate_limited',
      ip: '203.0.113.42',
      ipMasked: '203.0.113.xxx',
      metadata: { scope: 'login' },
    }));
  });
});

describe('Phase 5 security event coverage (2fa/**)', () => {
  it('2FA ルートが期待どおりのイベントを記録する', () => {
    const routeEvents: Array<[string, string[]]> = [
      ['2fa/verify/route.ts', ['2fa_enabled', 'login_failed', 'rate_limited']],
      ['2fa/challenge/verify/route.ts', ['login_failed', 'login_success', 'rate_limited']],
      ['2fa/disable/route.ts', ['2fa_disabled', 'rate_limited']],
      ['2fa/recovery-codes/regenerate/route.ts', ['2fa_enabled', 'rate_limited']],
    ];
    for (const [relativePath, eventTypes] of routeEvents) {
      const source = readFileSync(resolve(process.cwd(), 'src/app/api/auth', relativePath), 'utf8');
      expect(source, `${relativePath} should record security events`).toContain('recordSecurityEvent');
      for (const eventType of eventTypes) {
        expect(source, `${relativePath} should record ${eventType}`).toContain(`'${eventType}'`);
      }
    }
  });

  it('login は email 未確認の遮断で login_failed（reason=email_unverified）を記録する', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/auth/login/route.ts'), 'utf8');
    expect(source).toContain("reason: 'email_unverified'");
  });

  it('Passkey ルートが期待どおりのイベントを記録する（Phase 6）', () => {
    const routeEvents: Array<[string, string[]]> = [
      ['passkey/register/options/route.ts', ['rate_limited']],
      ['passkey/register/verify/route.ts', ['passkey_added', 'rate_limited']],
      ['passkey/login/options/route.ts', ['rate_limited']],
      ['passkey/login/verify/route.ts', ['login_failed', 'login_success', 'rate_limited']],
      ['passkey/route.ts', ['rate_limited']],
      ['passkey/[id]/route.ts', ['passkey_removed', 'rate_limited']],
      ['reauth/passkey/options/route.ts', ['rate_limited']],
    ];
    for (const [relativePath, eventTypes] of routeEvents) {
      const source = readFileSync(resolve(process.cwd(), 'src/app/api/auth', relativePath), 'utf8');
      expect(source, `${relativePath} should record security events`).toContain('recordSecurityEvent');
      for (const eventType of eventTypes) {
        expect(source, `${relativePath} should record ${eventType}`).toContain(`'${eventType}'`);
      }
    }
  });

  it('resend-verification は未認証経路で user_id が無い場合 null を渡す', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/auth/resend-verification/route.ts'), 'utf8');
    // eventUserId = user?.id ?? null
    expect(source).toMatch(/const eventUserId = user\?\.id \?\? null/);
    expect(source).toContain('recordSecurityEvent');
  });
});
