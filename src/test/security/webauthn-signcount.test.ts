import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
 * §10: sign counter の処理（D-34-06）。
 * - 後退（replay・クローン）は拒否する。
 * - `newCounter === 0`（カウンタ非対応の authenticator）は**後退判定をせず**通す。
 */

const userIds: string[] = [];

async function seedCredential(
  userId: string,
  auth: ReturnType<typeof createMockAuthenticator>,
  signCount: number,
): Promise<void> {
  await getDb().insert(webauthnCredentials).values({
    id: `wac_${uniq('c')}`,
    userId,
    credentialId: auth.credentialId,
    publicKey: auth.publicKey,
    signCount,
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

async function attempt(
  auth: ReturnType<typeof createMockAuthenticator>,
  signCount: number,
): Promise<number> {
  const { challenge, challengeId } = await beginLogin();
  const response = auth.createAuthenticationResponse({ challenge, signCount });
  const result = await loginVerify(
    anonRequest('/api/auth/passkey/login/verify', 'POST', { response, challenge_id: challengeId }),
  );
  return result.status;
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

describe('sign_count の処理 (§10 / D-34-06)', () => {
  it('後退する sign_count は 400', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth, 10);

    // 保存 10 に対し 5 を提示 → 後退。
    expect(await attempt(auth, 5)).toBe(400);
  });

  it('同じ sign_count も拒否する（単調増加のみ許可）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth, 10);

    expect(await attempt(auth, 10)).toBe(400);
  });

  it('増加する sign_count は通る', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth, 10);

    expect(await attempt(auth, 11)).toBe(200);

    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(rows[0]!.signCount).toBe(11);
  });

  it('newCounter === 0 の端末は 0 のまま繰り返しログインできる（カウンタ非対応・R3）', async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const auth = createMockAuthenticator({ rpID: 'localhost', origin: APP_URL });
    await seedCredential(user.id, auth, 0);

    expect(await attempt(auth, 0)).toBe(200);
    expect(await attempt(auth, 0)).toBe(200);

    // 0 は保存値を書き換えない。last_used_at だけ更新する（D-34-06）。
    const rows = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    expect(rows[0]!.signCount).toBe(0);
    expect(rows[0]!.lastUsedAt).not.toBeNull();
  });
});
