import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setCaptchaProvider,
  TurnstileCaptchaProvider,
  verifyCaptchaIfRequired,
  type CaptchaProvider,
} from '@/lib/auth/captcha';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
});

afterEach(() => {
  setCaptchaProvider(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it('asks the client to challenge (CAPTCHA_REQUIRED) when a token is missing in production', async () => {
    // The widget was never rendered or solved. The old code returned CAPTCHA_INVALID,
    // which made the soft-limit gate impossible to pass even with Turnstile set up (BUG-22).
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'configured');

    await expect(verifyCaptchaIfRequired(true, null))
      .rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED', status: 400 });
  });

  it('passes in production when the injected provider accepts the token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'configured');
    const provider: CaptchaProvider = { verify: vi.fn().mockResolvedValue(true) };
    setCaptchaProvider(provider);

    await expect(verifyCaptchaIfRequired(true, 'test-token')).resolves.toBeUndefined();
    expect(provider.verify).toHaveBeenCalledWith('test-token', undefined);
  });

  it('rejects with CAPTCHA_INVALID in production when the provider declines', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'configured');
    setCaptchaProvider({ verify: vi.fn().mockResolvedValue(false) });

    await expect(verifyCaptchaIfRequired(true, 'test-token'))
      .rejects.toMatchObject({ code: 'CAPTCHA_INVALID', status: 400 });
  });
});

describe('Turnstile provider', () => {
  it('posts the secret in the body and returns true on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TurnstileCaptchaProvider('my-secret', 1000);
    await expect(provider.verify('token-abc', '192.0.2.5')).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('siteverify');
    expect(String(url)).not.toContain('my-secret');
    const body = init.body as URLSearchParams;
    expect(body.get('secret')).toBe('my-secret');
    expect(body.get('response')).toBe('token-abc');
    expect(body.get('remoteip')).toBe('192.0.2.5');
  });

  it('returns false when the challenge fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) }));

    await expect(new TurnstileCaptchaProvider('s').verify('token')).resolves.toBe(false);
  });

  it('returns false for a missing token without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new TurnstileCaptchaProvider('s').verify(null)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with CAPTCHA_PROVIDER_ERROR when the network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(new TurnstileCaptchaProvider('s').verify('token'))
      .rejects.toMatchObject({ code: 'CAPTCHA_PROVIDER_ERROR', status: 503 });
  });

  it('fails closed with CAPTCHA_PROVIDER_ERROR on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(new TurnstileCaptchaProvider('s').verify('token'))
      .rejects.toMatchObject({ code: 'CAPTCHA_PROVIDER_ERROR', status: 503 });
  });
});
