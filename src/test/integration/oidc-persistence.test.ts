import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getPool } from '@/lib/db/client';
import { encryptOidcValue, hashClientSecret } from '@/lib/oidc/crypto';
import { PostgresOidcAdapter } from '@/lib/oidc/adapter';
import { ensureSubject } from '@/lib/oidc/subjects';
import { purgeOidcGrantArtifacts, revokeUserOidcGrants } from '@/lib/oidc/grants';
import { DEFAULT_ROLE_ID } from '@/lib/db/schema';

const uid = randomBytes(4).toString('hex');
const userId = `usr_oidcint_${uid}`;
const email = `oidc-int-${uid}@example.com`;
const username = `oidc_int_${uid}`;
const clientId = `cli_int_${uid}`;

beforeEach(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM oidc_artifacts WHERE model = $1', ['Client']);
  await pool.query('DELETE FROM oidc_artifacts WHERE model = ANY($1::text[])', [['AccessToken', 'AuthorizationCode', 'Interaction', 'Grant']]);
  await pool.query('DELETE FROM oidc_user_subjects WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM oidc_user_grants WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.query(
    `INSERT INTO users (id, username, email, email_verified, password_hash, status, role_id, password_changed_at)
     VALUES ($1, $2, $3, true, NULL, 'active', $4, now())`,
    [userId, username, email, DEFAULT_ROLE_ID],
  );
  await pool.query(
    `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
     VALUES ($1, 'Integration Client', 'Integration Operator', 'confidential',
             '["https://rp.example/callback"]'::jsonb, ARRAY['openid','profile','email']::text[],
             ARRAY[]::text[], 'client_secret_basic', $2)`,
    [clientId, hashClientSecret('sec_integration')],
  );
});

afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM oidc_user_subjects WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM oidc_user_grants WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM oidc_artifacts');
  await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.query("DELETE FROM security_events WHERE metadata->>'clientId' = $1", [clientId]);
  await pool.end();
});

async function seedGrant(scopes = ['openid', 'email']): Promise<{ grantId: string; subject: string }> {
  const subject = (await ensureSubject(userId, clientId))!;
  const grantId = `gra_int_${randomBytes(6).toString('hex')}`;
  await getPool().query(
    `INSERT INTO oidc_user_grants (id, user_id, client_id, scopes) VALUES ($1, $2, $3, $4::text[])`,
    [grantId, userId, clientId, scopes],
  );
  return { grantId, subject };
}

describe('OIDC PostgreSQL integration', () => {
  it('consumes an authorization code exactly once under concurrent exchanges', async () => {
    const { grantId, subject } = await seedGrant();
    const adapter = new PostgresOidcAdapter('AuthorizationCode');
    await adapter.upsert('code-int-1', { accountId: subject, grantId, clientId, scope: 'openid email' }, 300);

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => adapter.consume('code-int-1')));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    for (const failure of results.filter((result) => result.status === 'rejected')) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    }

    expect(await adapter.find('code-int-1')).toMatchObject({ accountId: subject, grantId });
    expect((await adapter.find('code-int-1'))!.consumed).toBeTypeOf('number');
  }, 20_000);

  it('refuses artifacts whose account is suspended, deleted, or unverified', async () => {
    const { grantId, subject } = await seedGrant();
    const adapter = new PostgresOidcAdapter('AccessToken');
    await adapter.upsert('at-int-1', { accountId: subject, grantId, clientId, scope: 'openid email' }, 600);
    expect(await adapter.find('at-int-1')).toBeTruthy();

    for (const [status, deleted] of [['suspended', false], ['pending_email', false], ['active', true]] as const) {
      await getPool().query('UPDATE users SET status = $2, deleted_at = $3 WHERE id = $1', [
        userId, status, deleted ? new Date() : null,
      ]);
      expect(await adapter.find('at-int-1'), `${status}/${deleted}`).toBeUndefined();
    }

    await getPool().query(`UPDATE users SET status = 'active', deleted_at = NULL WHERE id = $1`, [userId]);
    expect(await adapter.find('at-int-1')).toBeTruthy();
  });

  it('refuses artifacts once the grant or the client is revoked', async () => {
    const { grantId, subject } = await seedGrant();
    const adapter = new PostgresOidcAdapter('AccessToken');
    await adapter.upsert('at-int-2', { accountId: subject, grantId, clientId, scope: 'openid email' }, 600);
    expect(await adapter.find('at-int-2')).toBeTruthy();

    await getPool().query('UPDATE oidc_user_grants SET revoked_at = now() WHERE id = $1', [grantId]);
    expect(await adapter.find('at-int-2')).toBeUndefined();

    await getPool().query('UPDATE oidc_user_grants SET revoked_at = NULL WHERE id = $1', [grantId]);
    await getPool().query('UPDATE oauth_clients SET active = false, revoked_at = now() WHERE client_id = $1', [clientId]);
    expect(await adapter.find('at-int-2')).toBeUndefined();
    expect(await new PostgresOidcAdapter('Client').find(clientId)).toBeUndefined();
  });

  it('revoking a user grant removes every token artifact in one step', async () => {
    const { grantId, subject } = await seedGrant();
    const accessToken = new PostgresOidcAdapter('AccessToken');
    const code = new PostgresOidcAdapter('AuthorizationCode');
    await accessToken.upsert('at-int-3', { accountId: subject, grantId, clientId }, 600);
    await code.upsert('code-int-3', { accountId: subject, grantId, clientId }, 300);
    await new PostgresOidcAdapter('Grant').upsert(grantId, { accountId: subject, clientId }, 3600);

    const clients = await revokeUserOidcGrants(userId);
    expect(clients).toEqual([clientId]);

    expect(await accessToken.find('at-int-3')).toBeUndefined();
    expect(await code.find('code-int-3')).toBeUndefined();
    expect(await new PostgresOidcAdapter('Grant').find(grantId)).toBeUndefined();
    const remaining = await getPool().query('SELECT 1 FROM oidc_user_grants WHERE id = $1 AND revoked_at IS NULL', [grantId]);
    expect(remaining.rowCount).toBe(0);
  });

  it('purgeOidcGrantArtifacts only removes artifacts bound to that grant', async () => {
    const { grantId, subject } = await seedGrant();
    const pool = getPool();
    const otherClientId = `cli_int_other_${uid}`;
    await pool.query(
      `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
       VALUES ($1, 'Other Client', 'Integration Operator', 'public', '["https://other.example/cb"]'::jsonb,
               ARRAY['openid']::text[], ARRAY[]::text[], 'none', NULL)`,
      [otherClientId],
    );
    const otherSubject = (await ensureSubject(userId, otherClientId))!;
    const otherGrantId = `gra_int_other_${randomBytes(6).toString('hex')}`;
    await pool.query('INSERT INTO oidc_user_grants (id, user_id, client_id, scopes) VALUES ($1, $2, $3, $4::text[])', [
      otherGrantId, userId, otherClientId, ['openid'],
    ]);

    const adapter = new PostgresOidcAdapter('AccessToken');
    await adapter.upsert('at-int-4', { accountId: subject, grantId, clientId }, 600);
    await adapter.upsert('at-int-5', { accountId: otherSubject, grantId: otherGrantId, clientId: otherClientId }, 600);

    await purgeOidcGrantArtifacts(grantId);

    expect(await adapter.find('at-int-4')).toBeUndefined();
    expect(await adapter.find('at-int-5')).toBeTruthy();

    await pool.query('DELETE FROM oidc_user_subjects WHERE client_id = $1', [otherClientId]);
    await pool.query('DELETE FROM oidc_user_grants WHERE client_id = $1', [otherClientId]);
    await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [otherClientId]);
  });

  it('serves a public client without a secret and a confidential client only with a matching hash', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO oauth_clients (client_id, name, operator, client_type, redirect_uris, allowed_scopes, web_origins, token_endpoint_auth_method, secret_hash)
       VALUES ($1, 'Public', 'Integration Operator', 'public', '["https://rp.example/callback"]'::jsonb,
               ARRAY['openid']::text[], ARRAY['https://rp.example']::text[], 'none', NULL)`,
      [`cli_pub_${uid}`],
    );
    const publicMetadata = await new PostgresOidcAdapter('Client').find(`cli_pub_${uid}`);
    expect(publicMetadata).toMatchObject({ token_endpoint_auth_method: 'none', scope: 'openid' });
    expect(publicMetadata!.client_secret).toBeUndefined();

    const confidential = await new PostgresOidcAdapter('Client').find(clientId);
    expect(confidential).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic', scope: 'openid profile email' });
    expect(String(confidential!.client_secret).startsWith('hmac-sha256:')).toBe(true);
    expect(String(confidential!.client_secret)).not.toContain('sec_integration');

    await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [`cli_pub_${uid}`]);
  });

  it('never stores a raw authorization code or access token in the artifact table', async () => {
    const { grantId, subject } = await seedGrant();
    const rawCode = 'code-raw-value-should-not-appear';
    await new PostgresOidcAdapter('AuthorizationCode').upsert('code-int-6', { accountId: subject, grantId, clientId, codeChallenge: rawCode }, 300);
    await new PostgresOidcAdapter('AccessToken').upsert('at-int-6', { accountId: subject, grantId, clientId }, 600);

    const { rows } = await getPool().query<{ payload_ciphertext: string; id_hash: string }>(
      `SELECT payload_ciphertext, id_hash FROM oidc_artifacts WHERE model = ANY($1::text[])`,
      [['AuthorizationCode', 'AccessToken']],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload_ciphertext).toMatch(/^v1\./u);
      expect(row.payload_ciphertext).not.toContain(subject);
      expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/u);
    }
    void encryptOidcValue;
  });
});