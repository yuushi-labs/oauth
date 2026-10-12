import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RATE_LIMITS } from '@/config/rate-limits';

describe('Security - Rate Limiting Configuration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('register endpoint uses correct rate limit config', () => {
    expect(RATE_LIMITS.register.limit).toBe(5);
    expect(RATE_LIMITS.register.window).toBe(3600_000);
  });

  it('login endpoint uses correct rate limit config', () => {
    expect(RATE_LIMITS.login.ip.limit).toBe(20);
    expect(RATE_LIMITS.login.ip.window).toBe(300_000);
    expect(RATE_LIMITS.login.account.limit).toBe(5);
    expect(RATE_LIMITS.login.account.window).toBe(900_000);
  });

  it('forgot password has separate email and IP limits', () => {
    expect(RATE_LIMITS.forgot.email.limit).toBe(5);
    expect(RATE_LIMITS.forgot.email.window).toBe(3600_000);
    expect(RATE_LIMITS.forgot.ip.limit).toBe(10);
    expect(RATE_LIMITS.forgot.ip.window).toBe(3600_000);
  });

  it('resend has rate limits', () => {
    expect(RATE_LIMITS.resend.user.limit).toBe(5);
    expect(RATE_LIMITS.resend.user.window).toBe(3600_000);
    expect(RATE_LIMITS.resend.ip.limit).toBe(10);
    expect(RATE_LIMITS.resend.ip.window).toBe(3600_000);
  });
});