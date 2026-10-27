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

  it('email change has user and IP rate limits (§4.3 / §18)', () => {
    expect(RATE_LIMITS.emailChange.user.limit).toBe(5);
    expect(RATE_LIMITS.emailChange.user.window).toBe(3600_000);
    expect(RATE_LIMITS.emailChange.ip.limit).toBe(10);
    expect(RATE_LIMITS.emailChange.ip.window).toBe(3600_000);
  });

  it('2FA は 10/5 分（D-33-14）', () => {
    expect(RATE_LIMITS.twoFactor.limit).toBe(10);
    expect(RATE_LIMITS.twoFactor.window).toBe(300_000);
  });

  it('Passkey は 30/5 分（Phase 6・§16）', () => {
    expect(RATE_LIMITS.passkey.limit).toBe(30);
    expect(RATE_LIMITS.passkey.window).toBe(300_000);
  });

  it('管理 API は read / mutation で分離されている（Phase 7・§51）', () => {
    expect(RATE_LIMITS.admin.read.limit).toBe(120);
    expect(RATE_LIMITS.admin.read.window).toBe(60_000);
    expect(RATE_LIMITS.admin.mutation.limit).toBe(60);
    expect(RATE_LIMITS.admin.mutation.window).toBe(60_000);
    expect(RATE_LIMITS.admin.mutation.limit).toBeLessThan(RATE_LIMITS.admin.read.limit);
  });
});