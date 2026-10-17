import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmail, getEmailTransportOverride } from '@/lib/auth/email/send';
import { restoreResendEmail, useMemoryEmail } from '@/test/helpers/email';

afterEach(() => {
  restoreResendEmail();
});

describe('email transport seam (BUG-6)', () => {
  it('既定では差し替えなし（Resend が使われる）', () => {
    expect(getEmailTransportOverride()).toBeNull();
  });

  it('注入した transport が呼ばれ、本文と token を観測できる', async () => {
    const { outbox } = useMemoryEmail();
    await sendEmail({
      to: 'user@example.com',
      subject: 'テスト',
      html: '<a href="http://localhost:3000/reset-password?token=raw-token-value">link</a>',
      text: 'http://localhost:3000/reset-password?token=raw-token-value',
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe('user@example.com');
    expect(outbox[0]!.tokenFromUrl).toBe('raw-token-value');
  });

  it('restore で Resend に戻り、以降の送信は差し替えを使わない', () => {
    const transport = useMemoryEmail();
    expect(getEmailTransportOverride()).not.toBeNull();
    transport.restore();
    expect(getEmailTransportOverride()).toBeNull();
  });

  it('未設定の RESEND_API_KEY で sendEmail は throw する（seam 未使用時の従来挙動）', async () => {
    const previous = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await expect(sendEmail({ to: 'a@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow();
    } finally {
      if (previous !== undefined) process.env.RESEND_API_KEY = previous;
    }
  });

  it('deliverEmailSafely は失敗を握り、security_notification_failed を記録する', async () => {
    vi.resetModules();
    const recordSecurityEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/auth/security-events', () => ({ recordSecurityEvent }));
    vi.doMock('@/lib/util/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

    const { deliverEmailSafely } = await import('@/lib/auth/email/deliver');
    const ok = await deliverEmailSafely({
      kind: 'register_verification', userId: 'usr_1', ip: '203.0.113.5', userAgent: 'test',
      send: async () => { throw new Error('resend down'); },
    });

    expect(ok).toBe(false);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      'security_notification_failed', 'usr_1', '203.0.113.5', 'test', { kind: 'register_verification' },
    );
    vi.doUnmock('@/lib/auth/security-events');
    vi.doUnmock('@/lib/util/logger');
  });
});