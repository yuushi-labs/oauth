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

import { POST as registerOptions } from '@/app/api/auth/passkey/register/options/route';
import { POST as registerVerify } from '@/app/api/auth/passkey/register/verify/route';

/** §8.2 / §8.3: Passkey 登録の happy path と拒否条件（未確認 email・二重登録）。 */

const userIds: string[] = [];
const sessionIds: string[] = [];

async function issueOptions(session: { id: string; sessionHash: string; userId: string; csrfSecret: string; userAgent: string; ip: string; ipMasked: string | null; ipHash: string | null; deviceName: string; reauthVerifiedAt: string | null; totpPending: boolean }) {
  const response = await registerOptions(authedRequest('/api/auth/passkey/register/options', session, 'POST'));
  const body = await response.json();
  return { status: response.status, body };
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

describe('POST /api/auth/passkey/register/options (§8.2)', () => {
  it('再認証済み・email 確認済みなら options と challenge_id を返す', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id, { reauthed: true });
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const { status, body } = await issueOptions(session);
    expect(status).toBe(200);
    expect(body.data.options.rp.id).toBe('localhost');
    expect(typeof body.data.challenge_id).toBe('string');
    expect(body.data.options.challenge.length).toBeGreaterThanOrEqual(22);
  });

  it('再認証が未了なら 401 REAUTH_REQUIRED（D-34-08）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id);
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const { status, body } = await issueOptions(session);
    expect(status).toBe(401);
    expect(body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('email 未確認でも options を返す（D-40-02）', async () => {
    const user = await makeUser({ emailVerified: false });
    const session = sessionFor(user.id, { reauthed: true });
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const { status } = await issueOptions(session);
    expect(status).toBe(200);
  });
});

describe('POST /api/auth/passkey/register/verify (§8.3)', () => {
  it('実鍵の登録応答を検証して公開鍵のみ保存し、passkey_added を記録する', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id, { reauthed: true });
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const { body } = await issueOptions(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const response = auth.createRegistrationResponse({ challenge: body.data.options.challenge, backedUp: true });

    const verifyResponse = await registerVerify(
      authedRequest('/api/auth/passkey/register/verify', session, 'POST', {
        response,
        challenge_id: body.data.challenge_id,
        device_name: 'My YubiKey',
      }),
    );
    expect(verifyResponse.status).toBe(200);
    const verifyBody = await verifyResponse.json();
    expect(verifyBody.data.passkey.id.startsWith('wac_')).toBe(true);
    expect(verifyBody.data.passkey.device_name).toBe('My YubiKey');

    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.publicKey).toBe(auth.publicKey);
    expect(rows[0]!.signCount).toBe(0);
    expect(rows[0]!.backedUp).toBe(true);

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect(events.map((e) => e.eventType)).toContain('passkey_added');
    // metadata には device_name だけを入れる（credential_id は入れない・D-34-14）。
    const added = events.find((e) => e.eventType === 'passkey_added')!;
    expect(added.metadata).toEqual({ device_name: 'My YubiKey' });
  });

  it('device_name 未指定なら UA から導出した名前を使う（D-34-10）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id, { reauthed: true });
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const { body } = await issueOptions(session);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const response = auth.createRegistrationResponse({ challenge: body.data.options.challenge });

    const verifyResponse = await registerVerify(
      authedRequest('/api/auth/passkey/register/verify', session, 'POST', {
        response,
        challenge_id: body.data.challenge_id,
      }),
    );
    const verifyBody = await verifyResponse.json();
    expect(typeof verifyBody.data.passkey.device_name).toBe('string');
    expect(verifyBody.data.passkey.device_name.length).toBeGreaterThan(0);
  });

  it('同じ credential を二重登録すると 500 にならず拒否される（unique 制約）', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id, { reauthed: true });
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const first = await issueOptions(session);
    const firstResponse = auth.createRegistrationResponse({ challenge: first.body.data.options.challenge });
    const ok = await registerVerify(
      authedRequest('/api/auth/passkey/register/verify', session, 'POST', {
        response: firstResponse,
        challenge_id: first.body.data.challenge_id,
      }),
    );
    expect(ok.status).toBe(200);

    const second = await issueOptions(session);
    const secondResponse = auth.createRegistrationResponse({ challenge: second.body.data.options.challenge });
    const duplicate = await registerVerify(
      authedRequest('/api/auth/passkey/register/verify', session, 'POST', {
        response: secondResponse,
        challenge_id: second.body.data.challenge_id,
      }),
    );
    // 同一 credential の再登録は 4xx で拒否する（500 で漏らさない）。
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.status).toBeLessThan(500);

    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
  });
});
