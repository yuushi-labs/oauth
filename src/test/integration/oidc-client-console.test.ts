// @ts-nocheck
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/client';
import { createOidcClient, OidcClientForbiddenError, OidcClientLimitError, OidcClientNotFoundError, revokeOidcClient, rotateOidcClientSecret, updateOidcClient, findOidcClient, listOidcClients } from '@/lib/oidc/clients';
import { requireManageableClient } from '@/lib/oidc/clients';
import { PostgresOidcAdapter } from '@/lib/oidc/adapter';
import { DEFAULT_ROLE_ID, ROLE_IDS } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { hashIp } from '@/lib/util/ip';
import { protectRateLimitKey } from '@/lib/auth/rate-limit-keys';
import { cleanupTestRows } from '../helpers/http';
import { getEnv } from '@/lib/env';

const suffix = randomBytes(4).toString('hex');
const emails = [`console-owner-${suffix}@example.com`, `console-other-${suffix}@example.com`, `console-admin-${suffix}@example.com`];
const usernames = [`console_owner_${suffix}`, `console_other_${suffix}`, `console_admin_${suffix}`];
const userIds = [`usr_console_owner_${suffix}`, `usr_console_other_${suffix}`, `usr_console_admin_${suffix}`];
const clientIds: string[] = [];
const actor = (userId: string) => ({ userId, ip: '203.0.113.20', userAgent: 'vitest-integration' });

beforeAll(async () => {
  const pool = getPool();
  const password = await hashPassword('Integration-Strong-Pass-2026!');
  for (const [index, userId] of userIds.entries()) {
    await pool.query(
      `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id, password_changed_at)
       VALUES ($1, $2, $3, true, $4, 'active', $5, now())`,
      [userId, usernames[index], emails[index], password, index === 2 ? ROLE_IDS.admin : DEFAULT_ROLE_ID],
    );
  }
});

afterAll(async () => {
  const pool = getPool();
  const hashedIp = hashIp('203.0.113.20', getEnv().IP_HASH_PEPPER);
  const keys = [protectRateLimitKey(`rl:oidc-client:user:${userIds[0]}`)];
  await pool.query('DELETE FROM rate_limit_reservations WHERE key = ANY($1::text[])', [keys]);
  await pool.query('DELETE FROM rate_limit_hits WHERE key = ANY($1::text[])', [keys]);
  expect(hashedIp).toBeTruthy();
  await cleanupTestRows({ emails, usernames, clientIds });
  await pool.end();
});

describe('Integration - OIDC console client management', () => {
  it('creates a client owned by the user and stores only the secret digest', async () => {
    const created = await createOidcClient({
      name: 'Console App',
      operator: 'Console Operator',
      clientType: 'confidential',
      redirectUris: ['https://rp.example/callback'],
      scopes: ['openid', 'email'],
      webOrigins: [],
    }, actor(userIds[0]!));

    clientIds.push(created.clientId);
    expect(created.clientId).toMatch(/^cli_/);
    expect(created.clientSecret).toMatch(/^sec_/);

    const pool = getPool();
    const { rows } = await pool.query<{ owner_user_id: string; secret_hash: string; token_endpoint_auth_method: string }>(
      'SELECT owner_user_id, secret_hash, token_endpoint_auth_method FROM oauth_clients WHERE client_id = $1', [created.clientId],
    );
    expect(rows[0]!.owner_user_id).toBe(userIds[0]);
    expect(rows[0]!.secret_hash).toMatch(/^hmac-sha256:/);
    expect(rows[0]!.token_endpoint_auth_method).toBe('client_secret_basic');
    const serialized = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [created.clientId]);
    expect(JSON.stringify(serialized.rows)).not.toContain(created.clientSecret);
  });

  it('returns the client to its owner and hides it from other regular users', async () => {
    const created = await createOidcClient({
      name: 'Owned', operator: 'Owner', clientType: 'public',
      redirectUris: ['https://spa.example/cb'], scopes: ['openid'], webOrigins: ['https://spa.example'],
    }, actor(userIds[0]!));
    clientIds.push(created.clientId);

    const owned = await listOidcClients({ id: userIds[0]!, roleId: DEFAULT_ROLE_ID });
    expect(owned.map((client) => client.clientId)).toContain(created.clientId);
    const others = await listOidcClients({ id: userIds[1]!, roleId: DEFAULT_ROLE_ID });
    expect(others.map((client) => client.clientId)).not.toContain(created.clientId);

    await expect(requireManageableClient(created.clientId, userIds[1]!)).rejects.toBeInstanceOf(OidcClientForbiddenError);
    await expect(requireManageableClient(created.clientId, userIds[2]!)).resolves.toMatchObject({ clientId: created.clientId });
    const adminView = await listOidcClients({ id: userIds[2]!, roleId: ROLE_IDS.admin });
    expect(adminView.map((client) => client.clientId)).toContain(created.clientId);
  });

  it('applies redirect URI edits immediately to the provider adapter', async () => {
    const created = await createOidcClient({
      name: 'Edited', operator: 'Owner', clientType: 'confidential',
      redirectUris: ['https://rp.example/old'], scopes: ['openid'], webOrigins: [],
    }, actor(userIds[0]!));
    clientIds.push(created.clientId);

    const adapter = new PostgresOidcAdapter('Client');
    const before = await adapter.find(created.clientId);
    expect((before as { redirect_uris: string[] }).redirect_uris).toEqual(['https://rp.example/old']);

    await updateOidcClient(created.clientId, {
      name: 'Edited 2',
      operator: 'Owner 2',
      redirectUris: ['https://rp.example/old', 'http://localhost:3000/settings/applications/test/callback'],
      scopes: ['openid', 'profile', 'email'],
      webOrigins: [],
    }, actor(userIds[0]!));

    const after = await adapter.find(created.clientId) as { redirect_uris: string[]; scope: string; client_name: string };
    expect(after.redirect_uris).toContain('http://localhost:3000/settings/applications/test/callback');
    expect(after.scope).toBe('openid profile email');
    expect(after.client_name).toBe('Edited 2');
  });

  it('rotates the secret so the previous digest stops matching', async () => {
    const created = await createOidcClient({
      name: 'Rotating', operator: 'Owner', clientType: 'confidential',
      redirectUris: ['https://rp.example/cb'], scopes: ['openid'], webOrigins: [],
    }, actor(userIds[0]!));
    clientIds.push(created.clientId);

    const { verifyClientSecretHash } = await import('@/lib/oidc/crypto');
    const pool = getPool();
    const before = await pool.query<{ secret_hash: string }>('SELECT secret_hash FROM oauth_clients WHERE client_id = $1', [created.clientId]);
    expect(verifyClientSecretHash(before.rows[0]!.secret_hash, created.clientSecret!)).toBe(true);

    const rotated = await rotateOidcClientSecret(created.clientId, actor(userIds[0]!));
    expect(rotated).not.toBe(created.clientSecret);
    const after = await pool.query<{ secret_hash: string }>('SELECT secret_hash FROM oauth_clients WHERE client_id = $1', [created.clientId]);
    expect(verifyClientSecretHash(after.rows[0]!.secret_hash, created.clientSecret!)).toBe(false);
    expect(verifyClientSecretHash(after.rows[0]!.secret_hash, rotated)).toBe(true);
  });

  it('revoking a client deactivates it and purges its grants and tokens', async () => {
    const created = await createOidcClient({
      name: 'Revoked', operator: 'Owner', clientType: 'confidential',
      redirectUris: ['https://rp.example/cb'], scopes: ['openid'], webOrigins: [],
    }, actor(userIds[0]!));
    clientIds.push(created.clientId);

    const pool = getPool();
    await pool.query(
      `INSERT INTO oidc_user_grants (id, user_id, client_id, scopes) VALUES ($1, $2, $3, ARRAY['openid']::text[])`,
      [`gra_console_${suffix}`, userIds[0], created.clientId],
    );
    await pool.query(
      `INSERT INTO oidc_artifacts (model, id_hash, payload_ciphertext, expires_at)
       VALUES ('AccessToken', $1, 'payload', now() + interval '10 minutes')`,
      [`hash_${suffix}`],
    );
    await pool.query('UPDATE oidc_artifacts SET grant_id_hash = $1 WHERE model = \'AccessToken\'', [
      (await import('@/lib/oidc/crypto')).oidcIdHash(`gra_console_${suffix}`),
    ]);

    const revokedGrants = await revokeOidcClient(created.clientId, actor(userIds[0]!));
    expect(revokedGrants).toBe(1);

    const client = await pool.query<{ active: boolean; revoked_at: Date | null }>('SELECT active, revoked_at FROM oauth_clients WHERE client_id = $1', [created.clientId]);
    expect(client.rows[0]!.active).toBe(false);
    expect(client.rows[0]!.revoked_at).not.toBeNull();

    const grants = await pool.query('SELECT id FROM oidc_user_grants WHERE id = $1', [`gra_console_${suffix}`]);
    expect(grants.rowCount).toBe(1);
    const artifacts = await pool.query('SELECT id_hash FROM oidc_artifacts WHERE id_hash = $1', [`hash_${suffix}`]);
    expect(artifacts.rowCount).toBe(0);
    await expect(requireManageableClient(created.clientId, userIds[0]!)).rejects.toBeInstanceOf(OidcClientNotFoundError);
    await pool.query('DELETE FROM oidc_user_grants WHERE id = $1', [`gra_console_${suffix}`]);
  });

  it('enforces the per-user client limit', async () => {
    const pool = getPool();
    const first = await createOidcClient({
      name: 'Limit One', operator: 'Owner', clientType: 'confidential',
      redirectUris: ['https://rp.example/cb'], scopes: ['openid'], webOrigins: [],
    }, actor(userIds[1]!), { maxClientsPerUser: 1 });
    clientIds.push(first.clientId);

    await expect(createOidcClient({
      name: 'Limit Two', operator: 'Owner', clientType: 'confidential',
      redirectUris: ['https://rp.example/cb2'], scopes: ['openid'], webOrigins: [],
    }, actor(userIds[1]!), { maxClientsPerUser: 1 })).rejects.toBeInstanceOf(OidcClientLimitError);

    const stored = await pool.query('SELECT client_id FROM oauth_clients WHERE name = $1', ['Limit Two']);
    expect(stored.rowCount).toBe(0);
  });

  it('exposes owner and grant metadata for the console list', async () => {
    const created = await createOidcClient({
      name: 'Listed', operator: 'Listed Operator', clientType: 'public',
      redirectUris: ['https://spa.example/cb'], scopes: ['openid', 'profile'], webOrigins: ['https://spa.example'],
    }, actor(userIds[0]!));
    clientIds.push(created.clientId);
    const pool = getPool();
    await pool.query(
      `INSERT INTO oidc_user_grants (id, user_id, client_id, scopes, last_used_at) VALUES ($1, $2, $3, ARRAY['openid']::text[], now())`,
      [`gra_listed_${suffix}`, userIds[0], created.clientId],
    );

    const detail = await findOidcClient(created.clientId);
    expect(detail).toMatchObject({ name: 'Listed', operator: 'Listed Operator', ownerUsername: usernames[0] });

    const listed = (await listOidcClients({ id: userIds[0]!, roleId: DEFAULT_ROLE_ID })).find((client) => client.clientId === created.clientId);
    expect(listed?.grantCount).toBe(1);
    expect(listed?.isOwner).toBe(true);
    expect(listed?.lastUsedAt).toBeTruthy();
    await pool.query('DELETE FROM oidc_user_grants WHERE id = $1', [`gra_listed_${suffix}`]);
  });
});
