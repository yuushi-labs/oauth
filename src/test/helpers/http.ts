import { createServer } from 'node:http';
import { getPool } from '@/lib/db/client';
import { hashIp } from '@/lib/util/ip';
import { protectRateLimitKey } from '@/lib/auth/rate-limit-keys';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  seed(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  store(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const index = (pair ?? '').indexOf('=');
      if (index <= 0) continue;
      const name = (pair ?? '').slice(0, index).trim();
      const value = (pair ?? '').slice(index + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  describe(): string {
    return [...this.cookies].map(([name, value]) => `${name}[${value.length}]`).join(' ');
  }
}

export type HttpResult = {
  status: number;
  headers: Headers;
  body: string;
  json: <T = Record<string, unknown>>() => T;
};

export async function httpRequest(
  url: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  const response = await fetch(url, { ...init, headers, redirect: 'manual' });
  const body = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body,
    json: <T,>() => JSON.parse(body) as T,
  };
}

export async function clearOidcRateLimits(ip: string): Promise<void> {
  const pool = getPool();
  const pepper = process.env.IP_HASH_PEPPER ?? '';
  const hashedIp = hashIp(ip, pepper);
  const keys = [
    protectRateLimitKey(`oidc:authorize:public:${hashedIp}`),
    protectRateLimitKey(`oidc:interaction:${hashedIp}`),
  ];
  await pool.query('DELETE FROM rate_limit_reservations WHERE key = ANY($1::text[])', [keys]);
  await pool.query('DELETE FROM rate_limit_hits WHERE key = ANY($1::text[])', [keys]);
}

export async function cleanupTestRows(options: { emails: string[]; usernames: string[]; clientIds: string[] }): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM oidc_artifacts WHERE model = $1', ['Client']);
  await pool.query('DELETE FROM oidc_user_subjects WHERE client_id = ANY($1::text[])', [options.clientIds]);
  await pool.query('DELETE FROM oidc_user_grants WHERE client_id = ANY($1::text[])', [options.clientIds]);
  await pool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1::text[])', [options.clientIds]);
  await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::text[]))', [options.emails]);
  await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [options.emails]);
  await pool.query('DELETE FROM users WHERE username = ANY($1::text[])', [options.usernames]);
  await pool.query("DELETE FROM security_events WHERE metadata->>'clientId' = ANY($1::text[])", [options.clientIds]);
}