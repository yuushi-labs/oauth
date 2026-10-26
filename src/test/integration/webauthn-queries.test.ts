import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, users, webauthnChallenges, webauthnCredentials } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import {
  advanceSignCount,
  consumeChallengeRow,
  countCredentialsByUser,
  deleteCredential,
  findCredentialByCredentialId,
  findCredentialByIdForUser,
  insertChallenge,
  insertCredential,
  listCredentialsByUser,
} from '@/lib/db/queries/webauthn';

/**
 * §6 / D-34-06 / D-34-05: クエリ層を実 DB で検証する。
 * `sign_count` の atomic 更新（2 経路）と challenge の 1 回限り消費を固定する。
 */

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(deleted = false): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email: `${uniq('m')}@example.com`,
    emailVerified: true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: deleted ? 'deleted' : 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  if (deleted) {
    const db = getDb();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
  }
  createdUserIds.push(id);
  return id;
}

async function makeCredential(userId: string, signCount = 0): Promise<string> {
  const row = await insertCredential({
    userId,
    credentialId: `cred_${uniq('c')}`,
    publicKey: 'cHVibGljLWtleQ',
    signCount,
    transports: ['internal', 'hybrid'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    deviceName: 'テスト端末',
    backedUp: false,
  });
  return row.id;
}

afterEach(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, id));
    await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Integration - webauthn queries (D-34-05 / D-34-06)', () => {
  it('credential を挿入し、transports が string[] で往復する', async () => {
    const userId = await makeUser();
    const id = await makeCredential(userId);
    const [row] = await listCredentialsByUser(userId);
    expect(row?.id).toBe(id);
    expect(row?.transports).toEqual(['internal', 'hybrid']);
    expect(typeof row?.signCount).toBe('number');
    expect(await countCredentialsByUser(userId)).toBe(1);
  });

  it('findCredentialByIdForUser は owner 以外を返さない', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const id = await makeCredential(owner);
    expect(await findCredentialByIdForUser(id, owner)).not.toBeNull();
    expect(await findCredentialByIdForUser(id, other)).toBeNull();
  });

  it('findCredentialByCredentialId は削除済み user の credential を返さない', async () => {
    const active = await makeUser();
    const deleted = await makeUser(true);
    const activeRow = await insertCredential({
      userId: active,
      credentialId: `cred_${uniq('c')}`,
      publicKey: 'k',
      signCount: 0,
      transports: null,
      aaguid: null,
      deviceName: null,
      backedUp: false,
    });
    const deletedRow = await insertCredential({
      userId: deleted,
      credentialId: `cred_${uniq('c')}`,
      publicKey: 'k',
      signCount: 0,
      transports: null,
      aaguid: null,
      deviceName: null,
      backedUp: false,
    });
    expect(await findCredentialByCredentialId(activeRow.credentialId)).not.toBeNull();
    expect(await findCredentialByCredentialId(deletedRow.credentialId)).toBeNull();
  });

  it('deleteCredential は owner 以外を削除しない', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const id = await makeCredential(owner);
    expect(await deleteCredential(id, other)).toBe(false);
    expect(await findCredentialByIdForUser(id, owner)).not.toBeNull();
    expect(await deleteCredential(id, owner)).toBe(true);
    expect(await countCredentialsByUser(owner)).toBe(0);
  });

  it('advanceSignCount は newCounter>0 で単調増加のみ進める', async () => {
    const userId = await makeUser();
    const id = await makeCredential(userId, 5);
    const [credential] = await listCredentialsByUser(userId);
    expect(credential).toBeDefined();
    const credentialId = credential!.credentialId;

    expect(await advanceSignCount({ credentialId, userId, newCounter: 6 })).toBe(true);
    // 同じ値・小さい値は 0 行 → false（並行 replay / クローン）。
    expect(await advanceSignCount({ credentialId, userId, newCounter: 6 })).toBe(false);
    expect(await advanceSignCount({ credentialId, userId, newCounter: 3 })).toBe(false);
    expect(await advanceSignCount({ credentialId, userId, newCounter: 7 })).toBe(true);
  });

  it('advanceSignCount は newCounter===0 で last_used_at のみ更新する（後退判定しない）', async () => {
    const userId = await makeUser();
    const id = await makeCredential(userId, 0);
    const [credential] = await listCredentialsByUser(userId);
    const credentialId = credential!.credentialId;

    expect(await advanceSignCount({ credentialId, userId, newCounter: 0 })).toBe(true);
    const [after] = await listCredentialsByUser(userId);
    expect(after?.signCount).toBe(0);
    expect(after?.lastUsedAt).not.toBeNull();
    expect(after?.id).toBe(id);
  });

  it('consumeChallengeRow は同じ challenge を 1 回しか消費できない（D-34-05）', async () => {
    const userId = await makeUser();
    const id = await insertChallenge({
      userId,
      type: 'registration',
      challenge: 'chal-abc',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await consumeChallengeRow({ id, type: 'registration', userId });
    expect(first?.challenge).toBe('chal-abc');
    const second = await consumeChallengeRow({ id, type: 'registration', userId });
    expect(second).toBeNull();
  });

  it('consumeChallengeRow は期限切れ・type 不一致・他人の challenge を弾く', async () => {
    const userId = await makeUser();
    const other = await makeUser();

    const expired = await insertChallenge({
      userId,
      type: 'registration',
      challenge: 'chal-expired',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await consumeChallengeRow({ id: expired, type: 'registration', userId })).toBeNull();

    const wrongType = await insertChallenge({
      userId,
      type: 'registration',
      challenge: 'chal-type',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await consumeChallengeRow({ id: wrongType, type: 'authentication', userId })).toBeNull();

    const others = await insertChallenge({
      userId: other,
      type: 'registration',
      challenge: 'chal-other',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await consumeChallengeRow({ id: others, type: 'registration', userId })).toBeNull();
  });

  it('consumeChallengeRow は user_id IS NULL の discoverable ログイン challenge を消費できる', async () => {
    const id = await insertChallenge({
      userId: null,
      type: 'authentication',
      challenge: 'chal-discoverable',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consumed = await consumeChallengeRow({ id, type: 'authentication', userId: 'usr_anyone' });
    expect(consumed?.challenge).toBe('chal-discoverable');
    expect(consumed?.userId).toBeNull();
  });
});
