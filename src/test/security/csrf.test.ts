import { describe, expect, it, vi, beforeEach } from 'vitest';
import { validateCsrfToken, deriveCsrfToken } from '@/lib/auth/pipeline';
import type { SessionData } from '@/lib/auth/session';

vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    CSRF_SECRET: 'c'.repeat(43),
  }),
}));

describe('Security - CSRF Protection (validateCsrfToken)', () => {
  const mockSession: SessionData = {
    id: 'ses_123',
    userId: 'usr_123',
    sessionHash: 'hash',
    csrfSecret: 'secret',
    userAgent: 'UA',
    ip: '192.168.1.1',
    ipMasked: 'masked',
    deviceName: 'Unknown',
    reauthVerifiedAt: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects missing CSRF token', () => {
    expect(() => validateCsrfToken(null, mockSession)).toThrow('CSRF トークンが不足しています');
    expect(() => validateCsrfToken('', mockSession)).toThrow('CSRF トークンが不足しています');
  });

  it('rejects invalid CSRF token', () => {
    const invalidToken = 'invalid-token';
    expect(() => validateCsrfToken(invalidToken, mockSession)).toThrow('CSRF トークンが不一致です');
  });

  it('accepts valid CSRF token', () => {
    const validToken = deriveCsrfToken(mockSession);
    expect(() => validateCsrfToken(validToken, mockSession)).not.toThrow();
  });

  it('deriveCsrfToken produces consistent output', () => {
    const token1 = deriveCsrfToken(mockSession);
    const token2 = deriveCsrfToken(mockSession);
    expect(token1).toBe(token2);
    expect(token1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });
});