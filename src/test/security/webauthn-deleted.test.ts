import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { webauthnCredentials } from '@/lib/db/schema';
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

/**
 * §10 / §48「credential 削除後の認証」。
 * 削除は物理削除で、削除済みユーザーの credential は解決されない。
 */

const userIds: string[] = [];

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

async function beginLogin(): Promise<{ challenge: string; challengeId: string }> {
  const response = await loginOptions(anonRequest('/api/auth/passkey/login/options', 'POST'));
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

describe('削除済み credential の認証拒否 (§10 / §48)', () => {
  it('削除した credential では認証できない（400）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    // 削除（物理削除）。
    await getDb().delete(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge, signCount: 1 });
    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe('INVALID_CODE');
  });

  it('論理削除されたユーザーの credential では認証できない（400）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    // 論理削除（deleted_at）。`findCredentialByCredentialId` は削除済みユーザーを返さない。
    await getDb().execute(sql`UPDATE users SET deleted_at = NOW() WHERE id = ${user.id}`);

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge, signCount: 1 });
    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(400);
  });
});
