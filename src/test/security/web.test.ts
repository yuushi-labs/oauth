import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { isAllowedOrigin } from '@/lib/auth/pipeline';

afterEach(() => vi.unstubAllEnvs());

describe('Phase 2 web protections', () => {
  it('sets a fresh 128-bit CSP nonce and denies framing', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    const first = middleware(new NextRequest('http://localhost:3000/'));
    const second = middleware(new NextRequest('http://localhost:3000/'));
    const csp = first.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/nonce-([^' ]+)/)?.[1];
    expect(nonce).toBeTruthy();
    expect(Buffer.from(nonce ?? '', 'base64')).toHaveLength(16);
    expect(second.headers.get('content-security-policy')).not.toBe(csp);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(first.headers.get('x-frame-options')).toBe('DENY');
  });

  it('allows eval only for the Next.js development runtime', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    vi.stubEnv('NODE_ENV', 'development');
    const developmentCsp = middleware(new NextRequest('http://localhost:3000/'))
      .headers.get('content-security-policy') ?? '';
    expect(developmentCsp).toContain("'unsafe-eval'");

    vi.stubEnv('NODE_ENV', 'production');
    const productionCsp = middleware(new NextRequest('https://app.example/'))
      .headers.get('content-security-policy') ?? '';
    expect(productionCsp).not.toContain("'unsafe-eval'");
  });

  it('uses a strict CORS allowlist and never reflects an unapproved origin', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example,https://admin.example');
    const allowed = middleware(new NextRequest('https://app.example/api/auth/me', {
      headers: { origin: 'https://admin.example' },
    }));
    const denied = middleware(new NextRequest('https://app.example/api/auth/me', {
      headers: { origin: 'https://evil.example' },
    }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://admin.example');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('validates preflight origin, method, and requested headers', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example');
    const request = new NextRequest('https://app.example/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-csrf-token',
      },
    });
    expect(middleware(request).status).toBe(204);
    const badHeader = new NextRequest('https://app.example/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(middleware(badHeader).status).toBe(403);
  });

  it('blocks untrusted mutation origins but allows safe reads without CORS grants', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'https://app.example');
    const mutation = middleware(new NextRequest('https://app.example/api/auth/login', {
      method: 'POST', headers: { origin: 'https://evil.example' },
    }));
    const read = middleware(new NextRequest('https://app.example/api/auth/me', {
      headers: { origin: 'https://evil.example' },
    }));
    expect(mutation.status).toBe(403);
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('redirects production HTTP only to the canonical allowed host', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
    const redirect = middleware(new NextRequest('http://app.example/some/path?x=1'));
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('https://app.example/some/path?x=1');
    const forgedHost = middleware(new NextRequest('http://evil.example/some/path'));
    expect(forgedHost.status).toBe(400);
  });

  it('normalizes origin scheme/host/port and requires a trusted Referer when Origin is absent', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    vi.stubEnv('CSRF_TRUSTED_ORIGINS', 'https://app.example');
    expect(isAllowedOrigin('https://app.example')).toBe(true);
    expect(isAllowedOrigin('https://app.example:444')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin(null, 'https://app.example/path')).toBe(true);
    expect(isAllowedOrigin(null, 'https://evil.example/path')).toBe(false);
    expect(isAllowedOrigin(null, null)).toBe(false);
  });
});
