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
