import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { securityEvents, webauthnCredentials } from '@/lib/db/schema';
import { createMockAuthenticator } from '@/test/helpers/webauthn-mock';
import {
  APP_URL,
  authedRequest,
  cleanupPasskeyRows,
  clearPasskeyRateLimits,
  makeUser,
  persistSession,
  sessionFor,
  uniq,
} from '@/test/helpers/passkey-http';

vi.mock('next/headers', () => {
  const store = new Map<string, string>();
  return {
    cookies: async () => ({
      get: (name: string) => (store.has(name) ? { name, value: store.get(name) } : undefined),
      set: (name: string, value: string) => void store.set(name, value),
      delete: (name: string) => void store.delete(name),
    }),
  };
});

import { GET as getPasskeys } from '@/app/api/auth/passkey/route';
import { DELETE as deletePasskey } from '@/app/api/auth/passkey/[id]/route';
import { POST as reauthOptions } from '@/app/api/auth/reauth/passkey/options/route';
import { GET as status2fa } from '@/app/api/auth/2fa/route';

/**
 * §8.6 / §9.3: Passkey での強い再認証（D-34-11 / D-34-12）。
 * - `strong_reauth_methods` に 'passkey' が含まれる。
 * - Passkey で 2FA 無効化（＝削除系の強い再認証）が通る。
 * - 最後のログイン手段の削除は 409。
 * - IDOR（他人の credential）は 404。
 */

const userIds: string[] = [];
const sessionIds: string[] = [];

async function seedCredential(userId: string, auth: ReturnType<typeof createMockAuthenticator>): Promise<string> {
  const id = `wac_${uniq('c')}`;
  await getDb().insert(webauthnCredentials).values({
    id,
    userId,
    credentialId: auth.credentialId,
    publicKey: auth.publicKey,
    signCount: 0,
    transports: null,
    deviceName: 'Seeded key',
    backedUp: false,
  });
  return id;
}

/** 再認証用 Passkey assertion を作る（options 発行 → 署名）。 */
async function buildReauthAssertion(
  session: ReturnType<typeof sessionFor>,
  auth: ReturnType<typeof createMockAuthenticator>,
): Promise<{ passkey: unknown; challenge_id: string }> {
  const optionsResponse = await reauthOptions(
    authedRequest('/api/auth/reauth/passkey/options', session, 'POST'),
  );
  expect(optionsResponse.status).toBe(200);
  const { options, challenge_id } = (await optionsResponse.json()).data;
  const passkey = auth.createAuthenticationResponse({ challenge: options.challenge, signCount: 1 });
  return { passkey, challenge_id };
}

function deleteRequest(session: ReturnType<typeof sessionFor>, id: string, body: unknown) {
  return authedRequest(`/api/auth/passkey/${id}`, session, 'DELETE', body);
}

beforeEach(async () => {
  await clearPasskeyRateLimits();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', APP_URL);
  vi.stubEnv('ALLOWED_ORIGINS', APP_URL);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPasskeyRows(userIds.splice(0), sessionIds.splice(0));
});

afterAll(() => undefined);

describe('GET /api/auth/passkey (§8.1)', () => {
  it('一覧は内部 ID のみを返し、credential_id / public_key を出さない（§45）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const id = await seedCredential(user.id, auth);

    const response = await getPasskeys(authedRequest('/api/auth/passkey', session, 'GET'));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as { data: { passkeys: { id: string }[] } };

    expect(body.data.passkeys).toHaveLength(1);
    expect(body.data.passkeys[0]!.id).toBe(id);
    expect(raw).not.toContain(auth.credentialId);
    expect(raw).not.toContain(auth.publicKey);
    expect(raw).not.toContain('public_key');
    expect(raw).not.toContain('credential_id');
  });
});

describe('strong_reauth_methods (§8.1 / D-34-11)', () => {
  it('Passkey を持てば ["password", "passkey"] を返す', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const response = await status2fa(authedRequest('/api/auth/2fa', session, 'GET'));
    const { data } = await response.json();
    expect(data.strong_reauth_methods).toEqual(['password', 'passkey']);
  });

  it('Passkey が無ければ ["password"]', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const response = await status2fa(authedRequest('/api/auth/2fa', session, 'GET'));
    const { data } = await response.json();
    expect(data.strong_reauth_methods).toEqual(['password']);
  });
});

describe('DELETE /api/auth/passkey/{id} (§8.6)', () => {
  it('Passkey で再認証して削除できる（passwordHash ありなら最後の 1 件でも可）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const id = await seedCredential(user.id, auth);

    const assertion = await buildReauthAssertion(session, auth);
    const response = await deletePasskey(
      deleteRequest(session, id, { passkey: assertion.passkey, challenge_id: assertion.challenge_id }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);

    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(rows).toHaveLength(0);
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect(events.map((e) => e.eventType)).toContain('passkey_removed');
  });

  it('パスワード無し・Passkey 1 件・TOTP 無効なら 409 LAST_LOGIN_METHOD', async () => {
    const user = await makeUser({ password: null });
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const id = await seedCredential(user.id, auth);

    const assertion = await buildReauthAssertion(session, auth);
    const response = await deletePasskey(
      deleteRequest(session, id, { passkey: assertion.passkey, challenge_id: assertion.challenge_id }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('LAST_LOGIN_METHOD');

    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('他人の credential の削除は 404（IDOR 防止・§49）', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const session = sessionFor(attacker.id);
    userIds.push(owner.id, attacker.id);
    sessionIds.push(session.id);
    await persistSession(session);
    const ownerAuth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const ownerCredId = await seedCredential(owner.id, ownerAuth);
    const attackerAuth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(attacker.id, attackerAuth);

    const assertion = await buildReauthAssertion(session, attackerAuth);
    const response = await deletePasskey(
      deleteRequest(session, ownerCredId, {
        passkey: assertion.passkey,
        challenge_id: assertion.challenge_id,
      }),
      { params: Promise.resolve({ id: ownerCredId }) },
    );
    expect(response.status).toBe(404);

    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, owner.id));
    expect(rows).toHaveLength(1);
  });

  it('再認証（assertion）が無ければ 401 REAUTH_REQUIRED', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const id = await seedCredential(user.id, auth);

    const response = await deletePasskey(deleteRequest(session, id, {}), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('REAUTH_REQUIRED');
  });
});
