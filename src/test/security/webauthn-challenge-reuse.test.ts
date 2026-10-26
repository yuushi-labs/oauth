import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { webauthnChallenges, webauthnCredentials } from '@/lib/db/schema';
import { createMockAuthenticator } from '@/test/helpers/webauthn-mock';
import {
  APP_URL,
  anonRequest,
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

import { POST as registerOptions } from '@/app/api/auth/passkey/register/options/route';
import { POST as registerVerify } from '@/app/api/auth/passkey/register/verify/route';
import { POST as loginOptions } from '@/app/api/auth/passkey/login/options/route';
import { POST as loginVerify } from '@/app/api/auth/passkey/login/verify/route';

/** §10: challenge の 1 回限り消費（D-34-05 / D-16）。同じ challenge_id の 2 回目は必ず 400。 */

const userIds: string[] = [];
const sessionIds: string[] = [];

async function seedCredential(userId: string, auth: ReturnType<typeof createMockAuthenticator>): Promise<void> {
  await getDb().insert(webauthnCredentials).values({
    id: `wac_${uniq('c')}`,
    userId,
    credentialId: auth.credentialId,
    publicKey: auth.publicKey,
    signCount: 0,
    transports: null,
    deviceName: 'Seeded key',
    backedUp: false,
  });
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

describe('challenge 再利用の拒否 (§10 / D-34-05)', () => {
  it('ログインで同じ challenge_id を 2 回使うと 2 回目は 400', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const optionsResponse = await loginOptions(anonRequest('/api/auth/passkey/login/options', 'POST'));
    const { options, challenge_id } = (await optionsResponse.json()).data;
    const challenge = options.challenge;

    const first = auth.createAuthenticationResponse({ challenge, signCount: 1 });
    const ok = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response: first, challenge_id }),
    );
    expect(ok.status).toBe(200);

    const replay = auth.createAuthenticationResponse({ challenge, signCount: 2 });
    const rejected = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response: replay, challenge_id }),
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe('INVALID_CODE');

    // 2 回目はセッションを作らない（1 回目の 1 つだけ）。
    const { sessions } = await import('@/lib/db/schema');
    const rows = await getDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('登録で同じ challenge_id を 2 回使うと 2 回目は 400', async () => {
    const user = await makeUser();
    const session = sessionFor(user.id, { reauthed: true });
    userIds.push(user.id);
    sessionIds.push(session.id);
    await persistSession(session);

    const optionsResponse = await registerOptions(
      authedRequest('/api/auth/passkey/register/options', session, 'POST'),
    );
    const { options, challenge_id } = (await optionsResponse.json()).data;

    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const response = auth.createRegistrationResponse({ challenge: options.challenge });
    const first = await registerVerify(
      authedRequest('/api/auth/passkey/register/verify', session, 'POST', { response, challenge_id }),
    );
    expect(first.status).toBe(200);

    const second = await registerVerify(
      authedRequest('/api/auth/passkey/register/verify', session, 'POST', { response, challenge_id }),
    );
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe('INVALID_CODE');
  });

  it('消費済み challenge は DB 上も 1 行だけ consumed_at が入る（単文 UPDATE）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const optionsResponse = await loginOptions(anonRequest('/api/auth/passkey/login/options', 'POST'));
    const { options, challenge_id } = (await optionsResponse.json()).data;
    const challenge = options.challenge;
    const response = auth.createAuthenticationResponse({ challenge });
    await loginVerify(anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id }));

    const rows = await getDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.id, challenge_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
  });
});
