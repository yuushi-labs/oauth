import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { securityEvents, sessions, webauthnCredentials } from '@/lib/db/schema';
import { createMockAuthenticator } from '@/test/helpers/webauthn-mock';
import {
  APP_URL,
  anonRequest,
  cleanupPasskeyRows,
  clearPasskeyRateLimits,
  makeUser,
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

import { POST as loginOptions } from '@/app/api/auth/passkey/login/options/route';
import { POST as loginVerify } from '@/app/api/auth/passkey/login/verify/route';

/** §8.4 / §8.5: discoverable ログインの happy path と、新セッションの発行。 */

const userIds: string[] = [];

async function seedCredential(userId: string, auth: ReturnType<typeof createMockAuthenticator>): Promise<void> {
  await getDb().insert(webauthnCredentials).values({
    id: `wac_${uniq('c')}`,
    userId,
    credentialId: auth.credentialId,
    publicKey: auth.publicKey,
    signCount: 0,
    transports: ['internal'],
    deviceName: 'Seeded key',
    backedUp: false,
  });
}

async function beginLogin(): Promise<{ challenge: string; challengeId: string }> {
  const response = await loginOptions(anonRequest('/api/auth/passkey/login/options', 'POST'));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { challenge: body.data.options.challenge, challengeId: body.data.challenge_id };
}

beforeEach(async () => {
  await clearPasskeyRateLimits();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  vi.stubEnv('CSRF_TRUSTED_ORIGINS', APP_URL);
  vi.stubEnv('ALLOWED_ORIGINS', APP_URL);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPasskeyRows(userIds.splice(0), []);
});

afterAll(() => undefined);

describe('POST /api/auth/passkey/login/options (§8.4)', () => {
  it('未認証で呼べ、allowCredentials は空（discoverable）', async () => {
    const response = await loginOptions(anonRequest('/api/auth/passkey/login/options', 'POST'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.options.allowCredentials).toEqual([]);
    expect(body.data.options.rpId).toBe('localhost');
    expect(typeof body.data.challenge_id).toBe('string');
  });
});

describe('POST /api/auth/passkey/login/verify (§8.5)', () => {
  it('登録済み Passkey でログインでき、新セッションを発行し login_success(method=passkey) を記録する', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge, signCount: 5 });

    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(200);
    expect((await result.json()).data).toEqual({ message: 'ログインしました' });

    const rows = await getDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totpPending).toBe(false);

    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    const success = events.find((e) => e.eventType === 'login_success');
    expect(success?.metadata).toEqual({ method: 'passkey' });

    // sign_count が atomic に進んでいる。
    const creds = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(creds[0]!.signCount).toBe(5);
    expect(creds[0]!.lastUsedAt).not.toBeNull();
  });

  it('未知の credential は 400 INVALID_CODE（列挙耐性）', async () => {
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge });

    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe('INVALID_CODE');
  });

  it('停止中ユーザーの credential は 403 ACCOUNT_SUSPENDED', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);
    await getDb().execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${user.id}`);

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge });

    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(403);
    expect((await result.json()).error.code).toBe('ACCOUNT_SUSPENDED');
  });
});
