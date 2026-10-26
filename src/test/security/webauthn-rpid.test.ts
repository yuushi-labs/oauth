import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** §10: RP ID mismatch の拒否（D-34-01）。host ヘッダから rpID を導出しない。 */

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

describe('RP ID mismatch の拒否 (§10 / D-34-01)', () => {
  it('別 rpID で作られた assertion は 400', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge, rpID: 'evil.example' });
    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe('INVALID_CODE');
  });

  it('Host ヘッダを偽装しても rpID 検証は通らない（request ヘッダから導出しない）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge, rpID: 'evil.example' });
    const result = await loginVerify(
      anonRequest(
        '/api/auth/passkey/login/verify',
        'POST',
        { response, challenge_id: challengeId },
        { host: 'evil.example' },
      ),
    );
    expect(result.status).toBe(400);
  });

  it('正しい rpID は通る（対照）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth);

    const { challenge, challengeId } = await beginLogin();
    const response = auth.createAuthenticationResponse({ challenge, signCount: 1 });
    const result = await loginVerify(
      anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
    );
    expect(result.status).toBe(200);
  });
});
