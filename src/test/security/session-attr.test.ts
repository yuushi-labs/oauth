import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SESSION_COOKIE_NAME, ANON_COOKIE_NAME, generateAnonCsrfSecret } from '@/lib/auth/cookie';

describe('Security - Session Cookie Attributes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('SESSION_COOKIE_NAME uses __Host- prefix', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-auth_session');
  });

  it('ANON_COOKIE_NAME uses __Host- prefix', () => {
    expect(ANON_COOKIE_NAME).toBe('__Host-auth_anon');
  });

  it('generateAnonCsrfSecret returns base64url string', () => {
    const secret = generateAnonCsrfSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });

  it('generateAnonCsrfSecret returns different values', () => {
    const secret1 = generateAnonCsrfSecret();
    const secret2 = generateAnonCsrfSecret();
    expect(secret1).not.toBe(secret2);
  });
});