import { createHmac } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { isIP } from 'node:net';

function digest(value: string): string {
  const env = getEnv();
  return createHmac('sha256', env.RATE_LIMIT_SECRET ?? env.TOKEN_PEPPER)
    .update(value)
    .digest('hex');
}

export function hashRateLimitEmail(email: string): string {
  return digest(email.trim().toLowerCase());
}

export function hashRateLimitIp(ip: string): string {
  return digest(ipIdentity(ip));
}

function ipIdentity(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const address = ip.split('%')[0] ?? ip;
  const [left = '', right = ''] = address.split('::');
  const leftGroups = left.split(':').filter(Boolean);
  const rightGroups = right.split(':').filter(Boolean);
  const missing = Math.max(0, 8 - leftGroups.length - rightGroups.length);
  const expanded = [...leftGroups, ...Array.from({ length: missing }, () => '0'), ...rightGroups];
  return `${expanded.slice(0, 4).map((group) => (Number.parseInt(group, 16) || 0).toString(16)).join(':')}::/64`;
}

/** Hashes the complete logical key before it is stored in Redis or PostgreSQL. */
export function protectRateLimitKey(key: string): string {
  return digest(key);
}

export const rateLimitKeys = {
  registerIp: (ip: string) => `rl:register:ip:${hashRateLimitIp(ip)}`,
  loginIp: (ip: string) => `rl:login:ip:${hashRateLimitIp(ip)}`,
  loginAccount: (email: string) => `rl:login:acct:${hashRateLimitEmail(email)}`,
  loginIpAccount: (ip: string, email: string) => `rl:login:ip+acct:${hashRateLimitIp(ip)}:${hashRateLimitEmail(email)}`,
  forgotEmail: (email: string) => `rl:forgot:email:${hashRateLimitEmail(email)}`,
  forgotIp: (ip: string) => `rl:forgot:ip:${hashRateLimitIp(ip)}`,
  resendUser: (userId: string) => `rl:resend:user:${userId}`,
  resendEmail: (email: string) => `rl:resend:email:${hashRateLimitEmail(email)}`,
  resendIp: (ip: string) => `rl:resend:ip:${hashRateLimitIp(ip)}`,
  emailChangeUser: (userId: string) => `rl:email-change:user:${userId}`,
  emailChangeIp: (ip: string) => `rl:email-change:ip:${hashRateLimitIp(ip)}`,
  oauthStart: (ip: string) => `rl:oauth:start:${hashRateLimitIp(ip)}`,
  oauthCallback: (ip: string) => `rl:oauth:callback:${hashRateLimitIp(ip)}`,
  twoFactorUser: (userId: string) => `rl:2fa:user:${userId}`,
  passkeyIp: (ip: string) => `rl:passkey:ip:${hashRateLimitIp(ip)}`,
  settingsUser: (userId: string) => `rl:settings:user:${userId}`,
  oidcClientUser: (userId: string) => `rl:oidc-client:user:${userId}`,
  adminUser: (userId: string) => `rl:admin:user:${userId}`,
};
