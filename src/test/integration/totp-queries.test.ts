import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, recoveryCodes, totp, users } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import {
  consumeTotpCounter,
  enableTotpWithRecoveryCodes,
  findTotpByUserId,
  upsertTotpPending,
} from '@/lib/db/queries/totp';
import { consumeRecoveryCodeRow, countUnusedRecoveryCodes, insertRecoveryCodes } from '@/lib/db/queries/recovery-codes';
import { encryptTotpSecret } from '@/lib/auth/totp-crypto';
import { hashRecoveryCode, normalizeRecoveryCode } from '@/lib/auth/recovery-codes';

/**
 * §6 / R9 / D-33-04 / D-33-12: クエリ層の atomic 消費を実 DB で検証する。
 * `last_used_counter < c` と `used_at IS NULL` の単文 UPDATE が 2 回目に 0 行を返すことを固定する。
 */

const createdUserIds: string[] = [];
let seq = 0;
const uniq = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

async function makeUser(): Promise<string> {
  const id = `usr_${uniq('t')}`;
  await createUser({
    id,
    username: uniq('u'),
    email: `${uniq('m')}@example.com`,
    emailVerified: true,
    passwordHash: await hashPassword('Strong-Password-2026!'),
    status: 'active',
    roleId: DEFAULT_ROLE_ID,
  });
  createdUserIds.push(id);
  return id;
}

afterEach(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(totp).where(eq(totp.userId, id));
    await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

afterAll(() => undefined);

describe('Integration - totp counter atomic consume (R9 / D-33-04)', () => {
  it('upsertTotpPending は enabled=false で保存し、再 setup で上書きする', async () => {
    const userId = await makeUser();
    await upsertTotpPending(userId, encryptTotpSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    const first = await findTotpByUserId(userId);
    expect(first?.enabled).toBe(false);

    await upsertTotpPending(userId, encryptTotpSecret('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'));
    const second = await findTotpByUserId(userId);
    expect(second?.enabled).toBe(false);
    expect(second?.secretEncrypted).not.toBe(first?.secretEncrypted);
    expect(second?.lastUsedCounter).toBe(-1);
  });

  it('consumeTotpCounter は同じ counter の 2 回目に false を返す', async () => {
    const userId = await makeUser();
    await upsertTotpPending(userId, encryptTotpSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    await enableTotpWithRecoveryCodes(userId, []);

    expect(await consumeTotpCounter(userId, 100)).toBe(true);
    expect(await consumeTotpCounter(userId, 100)).toBe(false);
  });

  it('古い counter（単調減少）は false', async () => {
    const userId = await makeUser();
    await upsertTotpPending(userId, encryptTotpSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    await enableTotpWithRecoveryCodes(userId, []);

    expect(await consumeTotpCounter(userId, 100)).toBe(true);
    expect(await consumeTotpCounter(userId, 99)).toBe(false);
    // 大きい counter は通る
    expect(await consumeTotpCounter(userId, 101)).toBe(true);
  });

  it('bigint の往復で last_used_counter が数値として読める（R9）', async () => {
    const userId = await makeUser();
    await upsertTotpPending(userId, encryptTotpSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    await enableTotpWithRecoveryCodes(userId, []);
    await consumeTotpCounter(userId, 1_700_000_000);

    const row = await findTotpByUserId(userId);
    expect(typeof row?.lastUsedCounter).toBe('number');
    expect(row?.lastUsedCounter).toBe(1_700_000_000);
  });

  it('enableTotpWithRecoveryCodes は有効化とコード保存を同一トランザクションで行う', async () => {
    const userId = await makeUser();
    await upsertTotpPending(userId, encryptTotpSecret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    const hashes = ['h1', 'h2', 'h3'].map((v) => hashRecoveryCode(v));
    await enableTotpWithRecoveryCodes(userId, hashes);

    const row = await findTotpByUserId(userId);
    expect(row?.enabled).toBe(true);
    expect(row?.confirmedAt).not.toBeNull();
    expect(await countUnusedRecoveryCodes(userId)).toBe(3);
  });
});

describe('Integration - recovery code atomic consume (D-33-12)', () => {
  it('consumeRecoveryCodeRow は 2 回目に false', async () => {
    const userId = await makeUser();
    const hash = hashRecoveryCode(normalizeRecoveryCode('AAAAA-BBBBB-CCCCC-DDDDD'));
    await insertRecoveryCodes([{ userId, codeHash: hash }]);

    expect(await consumeRecoveryCodeRow(userId, hash)).toBe(true);
    expect(await consumeRecoveryCodeRow(userId, hash)).toBe(false);
    expect(await countUnusedRecoveryCodes(userId)).toBe(0);
  });

  it('別ユーザーのコードは消費できない（user_id 一致が必須）', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const hash = hashRecoveryCode('ZZZZZ');
    await insertRecoveryCodes([{ userId: owner, codeHash: hash }]);

    expect(await consumeRecoveryCodeRow(attacker, hash)).toBe(false);
    expect(await countUnusedRecoveryCodes(owner)).toBe(1);
  });

  it('存在しない hash は false', async () => {
    const userId = await makeUser();
    expect(await consumeRecoveryCodeRow(userId, hashRecoveryCode('nope'))).toBe(false);
  });
});
