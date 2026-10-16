// @ts-nocheck
import { createServer, request as requestHttp, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOidcHandler } from '../../../scripts/server';
import { getOidcProvider } from '@/lib/oidc/provider';
import { hashClientSecret } from '@/lib/oidc/crypto';
import { getPool } from '@/lib/db/client';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';
import { resetEnvCache } from '@/lib/env';
import { generateTestOidcKeys } from '../helpers/oidc-keys';
import { clearOidcRateLimits, freePort, httpRequest } from '../helpers/http';

function rawRequest(path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
    const request = requestHttp(new URL(path, issuer), { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

const uid = randomBytes(4).toString('hex');
const clientId = `cli_hdr_${uid}`;
let server: Server;
let issuer: string;

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}`;
  const keys = generateTestOidcKeys();
  process.env.OIDC_ISSUER = issuer;
  process.env.NEXT_PUBLIC_APP_URL = issuer;
  process.env.OIDC_JWKS_JSON = keys.jwks;
  process.env.OIDC_ADAPTER_ENCRYPTION_KEY = keys.adapterKey;
  resetEnvCache();
  await clearOidcRateLimits('127.0.0.1');

  const provider = (await getOidcProvider())!;
  server = createServer((req, res) => {
    void createOidcHandler(provider)(req, res).then((handled) => {
      if (!handled && !res.headersSent) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  await getPool().query(
    `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
     VALUES ($1, 'Header Client', 'Header Operator', 'confidential', '["https://rp.example/cb"]'::jsonb,
             ARRAY['openid','email']::text[], ARRAY[]::text[], 'client_secret_basic', $2)`,
    [clientId, hashClientSecret('sec_headers')],
  );
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await clearOidcRateLimits('127.0.0.1');
  await getPool().query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId]);
  await getPool().query('DELETE FROM users WHERE id = $1', [`usr_hdr_${uid}`]);
  await getPool().query("DELETE FROM security_events WHERE metadata->>'clientId' = $1", [clientId]);
  await getPool().end();
});

describe('Security - OIDC transport headers', () => {
  it('applies no-store, no-referrer and frame denial to discovery and jwks', async () => {
    for (const path of ['/.well-known/openid-configuration', '/oauth2/jwks']) {
      const response = await httpRequest(new URL(path, issuer).toString());
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control'), path).toContain('no-store');
      expect(response.headers.get('pragma'), path).toBe('no-cache');
      expect(response.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
    }
  });

  it('applies the same headers to authorize and token responses', async () => {
    const authorize = await httpRequest(new URL('/oauth2/authorize', issuer).toString());
    expect(authorize.status).toBe(400);
    expect(authorize.headers.get('referrer-policy')).toBe('no-referrer');
    expect(authorize.headers.get('x-frame-options')).toBe('DENY');

    const token = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'grant_type=authorization_code',
    });
    expect(token.status).toBe(400);
    expect(token.headers.get('cache-control')).toContain('no-store');
    expect(token.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rejects requests whose Host does not match the configured issuer origin', async () => {
    const result = await rawRequest('/oauth2/jwks', { host: 'attacker.example' });
    expect(result.status).toBe(400);
    expect(result.body).toContain('Invalid OIDC request origin');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect(result.headers['x-frame-options']).toBe('DENY');
  });

  it('answers a malformed interaction uid with a safe error page', async () => {
    const response = await httpRequest(new URL('/oauth2/interaction/does-not-exist', issuer).toString());
    expect(response.status).toBe(400);
    expect(response.body).not.toContain('stack');
    expect(response.body).not.toContain('Error:');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('Security - OIDC endpoint rate limits', () => {
  it('rate limits the authorize endpoint per IP', async () => {
    await clearOidcRateLimits('127.0.0.1');
    let limited: Awaited<ReturnType<typeof httpRequest>> | null = null;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await httpRequest(new URL('/oauth2/authorize', issuer).toString());
      if (response.status === 429) limited = response;
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get('retry-after')).toMatch(/^\d+$/u);
    expect(limited!.body).toBe('Too Many Requests');

    const events = await getPool().query<{ event_type: string }>(
      `SELECT event_type FROM security_events WHERE metadata->>'scope' = 'oidc_authorize' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(events.rows[0]?.event_type).toBe('rate_limited');
  }, 30_000);

  it('rate limits the token endpoint per client', async () => {
    await clearOidcRateLimits('127.0.0.1');
    const basic = `Basic ${Buffer.from(`${clientId}:wrong`).toString('base64')}`;
    let limited: Awaited<ReturnType<typeof httpRequest>> | null = null;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await httpRequest(new URL('/oauth2/token', issuer).toString(), {
        method: 'POST',
        headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: 'grant_type=authorization_code',
      });
      if (response.status === 429) limited = response;
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get('retry-after')).toMatch(/^\d+$/u);
  }, 30_000);

  it('rate limits the interaction endpoint per IP', async () => {
    await clearOidcRateLimits('127.0.0.1');
    let limited: Awaited<ReturnType<typeof httpRequest>> | null = null;
    for (let attempt = 0; attempt < 80 && !limited; attempt += 1) {
      const response = await httpRequest(new URL('/oauth2/interaction/unknown-uid', issuer).toString());
      if (response.status === 429) limited = response;
    }
    expect(limited).not.toBeNull();
  }, 30_000);
});

void vi;
void DEFAULT_ROLE_ID;