import { describe, expect, it } from 'vitest';
import { hashRateLimitEmail, hashRateLimitIp, protectRateLimitKey, rateLimitKeys } from '@/lib/auth/rate-limit-keys';

describe('rate limit key privacy', () => {
  it('normalizes email identifiers before HMAC hashing', () => {
    expect(hashRateLimitEmail('  User@Example.com ')).toBe(hashRateLimitEmail('user@example.com'));
    expect(hashRateLimitEmail('user@example.com')).not.toContain('user@example.com');
  });

  it('groups equivalent IPv6 addresses by their /64 prefix', () => {
    expect(hashRateLimitIp('2001:db8:1:2::abcd')).toBe(hashRateLimitIp('2001:0db8:0001:0002:ffff::1'));
  });

  it('protects stored keys and exposes all 13 configured key builders', () => {
    const built = [
      rateLimitKeys.registerIp('192.0.2.1'), rateLimitKeys.loginIp('192.0.2.1'),
      rateLimitKeys.loginAccount('a@example.com'), rateLimitKeys.loginIpAccount('192.0.2.1', 'a@example.com'),
      rateLimitKeys.forgotEmail('a@example.com'), rateLimitKeys.forgotIp('192.0.2.1'),
      rateLimitKeys.resendUser('usr_1'), rateLimitKeys.resendIp('192.0.2.1'),
      rateLimitKeys.oauthStart('192.0.2.1'), rateLimitKeys.oauthCallback('192.0.2.1'),
      rateLimitKeys.twoFactorUser('usr_1'), rateLimitKeys.passkeyIp('192.0.2.1'),
      rateLimitKeys.settingsUser('usr_1'),
    ];
    expect(built).toHaveLength(13);
    expect(protectRateLimitKey(built[0] ?? '')).toMatch(/^[a-f0-9]{64}$/);
    expect(protectRateLimitKey(built[0] ?? '')).not.toBe(built[0]);
  });
});
