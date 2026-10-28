import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { purgeExpired } from '../../../scripts/purge-expired';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
const db = drizzle(pool);

beforeAll(async () => {
  await db.execute(sql.raw(`CREATE TEMP TABLE rate_limit_reservations (
    reservation_id text PRIMARY KEY, key text NOT NULL, expires_at timestamptz NOT NULL, status text NOT NULL
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE rate_limit_hits (
    key text PRIMARY KEY, generation integer NOT NULL DEFAULT 1, failed_count integer NOT NULL DEFAULT 0,
    window_expires_at timestamptz NOT NULL
  )`));
  for (const table of ['email_verification_tokens', 'password_reset_tokens', 'email_change_requests']) {
    await db.execute(sql.raw(`CREATE TEMP TABLE ${table} (
      id text PRIMARY KEY, expires_at timestamptz NOT NULL, used_at timestamptz
    )`));
  }
  await db.execute(sql.raw(`CREATE TEMP TABLE sessions (
    id text PRIMARY KEY, expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE oidc_artifacts (
    model text NOT NULL, id_hash text NOT NULL, grant_id_hash text, uid_hash text, user_code_hash text,
    payload_ciphertext text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(), PRIMARY KEY (model, id_hash)
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE oauth_states (
    state_hash text PRIMARY KEY, provider text NOT NULL, intent text NOT NULL DEFAULT 'login',
    user_id text, nonce text NOT NULL, code_verifier text NOT NULL, redirect_to text,
    created_at timestamptz NOT NULL DEFAULT NOW(), expires_at timestamptz NOT NULL, consumed_at timestamptz
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE oauth_social_claims (
    state_hash text PRIMARY KEY, provider text NOT NULL, provider_account_id text NOT NULL,
    provider_email text, email_verified boolean NOT NULL DEFAULT false, email_owner_id text,
    created_at timestamptz NOT NULL DEFAULT NOW(), expires_at timestamptz NOT NULL, consumed_at timestamptz
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE webauthn_challenges (
    id text PRIMARY KEY, user_id text, type text NOT NULL, challenge text NOT NULL,
    expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE oidc_user_grants (
    id text PRIMARY KEY, user_id text NOT NULL, client_id text NOT NULL,
    scopes text[] NOT NULL DEFAULT ARRAY['openid']::text[], created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(), last_used_at timestamptz, revoked_at timestamptz
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE security_events (
    id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE TEMP TABLE users (
    id text PRIMARY KEY, status text NOT NULL DEFAULT 'active', deleted_at timestamptz
  )`));
});

afterAll(async () => {
  await pool.end();
});

describe('expired data cleanup', () => {
  it('removes only expired rows from each retention table and expires active reservations', async () => {
    await db.execute(sql`INSERT INTO rate_limit_reservations VALUES
      ('reservation-expired', 'key-expired', NOW() - INTERVAL '1 hour', 'confirmed'),
      ('reservation-active-expired', 'key-active-expired', NOW() - INTERVAL '1 hour', 'active'),
      ('reservation-active-valid', 'key-protected', NOW() + INTERVAL '1 hour', 'active')`);
    await db.execute(sql`INSERT INTO rate_limit_hits VALUES
      ('key-expired', 1, 1, NOW() - INTERVAL '1 hour'),
      ('key-active-expired', 1, 1, NOW() - INTERVAL '1 hour'),
      ('key-protected', 1, 1, NOW() - INTERVAL '1 hour')`);
    await db.execute(sql`INSERT INTO email_verification_tokens VALUES
      ('verify-expired', NOW() - INTERVAL '1 hour', NULL),
      ('verify-used', NOW() + INTERVAL '1 hour', NOW()),
      ('verify-valid', NOW() + INTERVAL '1 hour', NULL)`);
    await db.execute(sql`INSERT INTO password_reset_tokens VALUES
      ('reset-expired', NOW() - INTERVAL '1 hour', NULL),
      ('reset-valid', NOW() + INTERVAL '1 hour', NULL)`);
    await db.execute(sql`INSERT INTO email_change_requests VALUES
      ('change-expired', NOW() - INTERVAL '1 hour', NULL),
      ('change-valid', NOW() + INTERVAL '1 hour', NULL)`);
    await db.execute(sql`INSERT INTO sessions VALUES
      ('session-expired', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', NULL),
      ('session-revoked-old', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', NOW() - INTERVAL '31 days'),
      ('session-valid', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', NULL),
      ('session-revoked-recent', NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', NOW() - INTERVAL '1 day')`);
    await db.execute(sql`INSERT INTO oidc_artifacts (model, id_hash, payload_ciphertext, expires_at, consumed_at) VALUES
      ('AccessToken', 'artifact-expired', 'cipher', NOW() - INTERVAL '1 hour', NULL),
      ('AuthorizationCode', 'artifact-consumed-old', 'cipher', NOW() + INTERVAL '1 hour', NOW() - INTERVAL '2 days'),
      ('AccessToken', 'artifact-valid', 'cipher', NOW() + INTERVAL '1 hour', NULL)`);
    await db.execute(sql`INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, expires_at, consumed_at) VALUES
      ('expired-state', 'google', 'nonce', 'verifier', NOW() - INTERVAL '1 hour', NULL),
      ('consumed-old-state', 'github', 'nonce', 'verifier', NOW() + INTERVAL '1 hour', NOW() - INTERVAL '2 days'),
      ('consumed-recent-state', 'github', 'nonce', 'verifier', NOW() + INTERVAL '1 hour', NOW() - INTERVAL '10 minutes'),
      ('valid-state', 'google', 'nonce', 'verifier', NOW() + INTERVAL '10 minutes', NULL)`);
    await db.execute(sql`INSERT INTO oauth_social_claims
      (state_hash, provider, provider_account_id, email_verified, expires_at, consumed_at) VALUES
      ('claim-expired', 'google', 'sub-1', true, NOW() - INTERVAL '1 hour', NULL),
      ('claim-consumed-old', 'github', 'sub-2', true, NOW() + INTERVAL '1 hour', NOW() - INTERVAL '2 days'),
      ('claim-consumed-recent', 'github', 'sub-3', true, NOW() + INTERVAL '1 hour', NOW() - INTERVAL '10 minutes'),
      ('claim-valid', 'google', 'sub-4', true, NOW() + INTERVAL '10 minutes', NULL)`);
    await db.execute(sql`INSERT INTO oidc_user_grants (id, user_id, client_id, scopes, revoked_at) VALUES
      ('grant-revoked-old', 'usr_purge', 'cli_purge', ARRAY['openid'], NOW() - INTERVAL '31 days'),
      ('grant-revoked-recent', 'usr_purge', 'cli_purge', ARRAY['openid'], NOW() - INTERVAL '1 day')`);
    await db.execute(sql`INSERT INTO webauthn_challenges (id, type, challenge, expires_at, consumed_at) VALUES
      ('wch_expired', 'registration', 'c1', NOW() - INTERVAL '1 hour', NULL),
      ('wch_consumed_old', 'authentication', 'c2', NOW() + INTERVAL '1 hour', NOW() - INTERVAL '2 days'),
      ('wch_consumed_recent', 'authentication', 'c3', NOW() + INTERVAL '1 hour', NOW() - INTERVAL '10 minutes'),
      ('wch_valid', 'registration', 'c4', NOW() + INTERVAL '10 minutes', NULL)`);
    await db.execute(sql`INSERT INTO security_events (id, created_at) VALUES
      ('event-old', NOW() - INTERVAL '181 days'),
      ('event-boundary', NOW() - INTERVAL '179 days'),
      ('event-recent', NOW() - INTERVAL '1 day')`);
    await db.execute(sql`INSERT INTO users (id, status, deleted_at) VALUES
      ('usr_deleted_old', 'deleted', NOW() - INTERVAL '31 days'),
      ('usr_deleted_recent', 'deleted', NOW() - INTERVAL '1 day'),
      ('usr_suspended_old', 'suspended', NOW() - INTERVAL '31 days'),
      ('usr_active', 'active', NULL)`);

    const result = await purgeExpired(db);

    expect(result).toEqual({
      reservation: 1,
      'expired reservation': 1,
      'rate limit counter': 2,
      'email verification token': 2,
      'password reset token': 1,
      'email change request': 1,
      session: 2,
      'OIDC artifact': 2,
      'revoked OIDC grant': 1,
      'oauth state': 2,
      'social claim': 2,
      'webauthn challenge': 2,
      'security event': 1,
      'deleted user': 1,
    });

    const reservations = await db.execute(sql`SELECT reservation_id, status FROM rate_limit_reservations ORDER BY reservation_id`);
    expect(reservations.rows).toEqual([
      { reservation_id: 'reservation-active-expired', status: 'expired' },
      { reservation_id: 'reservation-active-valid', status: 'active' },
    ]);
    const counters = await db.execute(sql`SELECT key FROM rate_limit_hits ORDER BY key`);
    expect(counters.rows).toEqual([{ key: 'key-protected' }]);
    const sessions = await db.execute(sql`SELECT id FROM sessions ORDER BY id`);
    expect(sessions.rows).toEqual([{ id: 'session-revoked-recent' }, { id: 'session-valid' }]);
    const artifacts = await db.execute(sql`SELECT id_hash FROM oidc_artifacts ORDER BY id_hash`);
    expect(artifacts.rows).toEqual([{ id_hash: 'artifact-valid' }]);
    const grants = await db.execute(sql`SELECT id FROM oidc_user_grants ORDER BY id`);
    expect(grants.rows).toEqual([{ id: 'grant-revoked-recent' }]);
    const oauthStates = await db.execute(sql`SELECT state_hash FROM oauth_states ORDER BY state_hash`);
    expect(oauthStates.rows).toEqual([{ state_hash: 'consumed-recent-state' }, { state_hash: 'valid-state' }]);
    const claims = await db.execute(sql`SELECT state_hash FROM oauth_social_claims ORDER BY state_hash`);
    expect(claims.rows).toEqual([{ state_hash: 'claim-consumed-recent' }, { state_hash: 'claim-valid' }]);
    const challenges = await db.execute(sql`SELECT id FROM webauthn_challenges ORDER BY id`);
    expect(challenges.rows).toEqual([{ id: 'wch_consumed_recent' }, { id: 'wch_valid' }]);
    const events = await db.execute(sql`SELECT id FROM security_events ORDER BY id`);
    expect(events.rows).toEqual([{ id: 'event-boundary' }, { id: 'event-recent' }]);
    const remainingUsers = await db.execute(sql`SELECT id FROM users ORDER BY id`);
    expect(remainingUsers.rows).toEqual([
      { id: 'usr_active' },
      { id: 'usr_deleted_recent' },
      { id: 'usr_suspended_old' },
    ]);
  });
});
