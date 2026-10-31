import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentSecurityPolicy, TURNSTILE_ORIGIN } from '@/lib/security/csp';
import {
  assertCaptchaConfigConsistent,
  turnstileSecretConfigured,
  turnstileSiteKey,
} from '@/lib/auth/captcha-config';

/**
 * BUG-22: Phase 9 shipped only the server half of Turnstile. Without a site key, a widget,
 * and a CSP that allows challenges.cloudflare.com, the soft-limit CAPTCHA gate was
 * impossible to pass in production. These tests pin the client-side contract.
 */
describe('CSP - Turnstile origin', () => {
  const base = { nonce: 'abc123', allowEval: false };

  it('keeps the minimal policy when Turnstile is off', () => {
    const csp = contentSecurityPolicy({ ...base, turnstile: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain(TURNSTILE_ORIGIN);
    expect(csp).not.toContain('frame-src');
  });

  it('allows the Turnstile script and challenge iframe when enabled', () => {
    const csp = contentSecurityPolicy({ ...base, turnstile: true });
    expect(csp).toContain(TURNSTILE_ORIGIN);
    // The challenge renders in an iframe, so frame-src must name the origin too.
    expect(csp).toContain(`frame-src ${TURNSTILE_ORIGIN}`);
  });

  it('never emits unsafe-inline for scripts', () => {
    const csp = contentSecurityPolicy({ ...base, turnstile: true, allowEval: true });
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("'unsafe-eval'");
  });
});

describe('captcha-config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the site key and trims it', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '  site-key  ');
    expect(turnstileSiteKey()).toBe('site-key');
  });

  it('treats a blank site key as unset', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '   ');
    expect(turnstileSiteKey()).toBeUndefined();
  });

  it('reports whether the secret is configured', () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    expect(turnstileSecretConfigured()).toBe(true);
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    expect(turnstileSecretConfigured()).toBe(false);
  });

  it('allows both-unset and both-set in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    expect(() => assertCaptchaConfigConsistent()).not.toThrow();

    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    expect(() => assertCaptchaConfigConsistent()).not.toThrow();
  });

  it('fails fast in production when only the secret is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    expect(() => assertCaptchaConfigConsistent()).toThrow(/NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
  });

  it('fails fast in production when only the site key is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    expect(() => assertCaptchaConfigConsistent()).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it('does not enforce the pairing outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    expect(() => assertCaptchaConfigConsistent()).not.toThrow();
  });
});
