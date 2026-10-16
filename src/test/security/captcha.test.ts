import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCaptchaIfRequired } from '@/lib/auth/captcha';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CAPTCHA hook', () => {
  it('does not challenge requests below the soft limit, including production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(verifyCaptchaIfRequired(false, null)).resolves.toBeUndefined();
  });

  it('accepts the local no-op provider in development when a challenge is required', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await expect(verifyCaptchaIfRequired(true, null, '192.0.2.1')).resolves.toBeUndefined();
  });

  it('fails closed in production when the provider is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(verifyCaptchaIfRequired(true, 'test-token'))
      .rejects.toMatchObject({ code: 'CAPTCHA_UNCONFIGURED', status: 500 });
  });

  it('fails closed in production while the real provider is not connected', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'configured-but-not-used');

    await expect(verifyCaptchaIfRequired(true, 'test-token'))
      .rejects.toMatchObject({ code: 'CAPTCHA_PROVIDER_ERROR', status: 503 });
  });
});
