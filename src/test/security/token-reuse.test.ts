import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  DEFAULT_ROLE_ID,
  emailChangeRequests,
  emailVerificationTokens,
  passwordResetTokens,
  users,
} from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { hashToken } from '@/lib/auth/tokens/generate';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';

/**
 * D-16: 「1 回限り」の値は `UPDATE ... WHERE <未消費>` の更新行数で消費する。
 *
 * 以前のテストは DB をモックし「SELECT が usedAt を返す」ことで再利用を模擬していたが、
 * それは実装の 2 段書き（read → 判定 → write）に依存しており、**並行消費の競合を
 * 検出できなかった**（実装を単文 UPDATE に変えた瞬間、モック前提が崩れて無意味になる）。
 * ここでは実 PostgreSQL に対して並行リクエストを投げ、成功が 1 本だけであることを固定する。
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

const future = (): Date => new Date(Date.now() + 60 * 60 * 1000);
const past = (): Date => new Date(Date.now() - 60 * 60 * 1000);

async function insertVerification(userId: string, hash: string, expiresAt: Date): Promise<void> {
  await getDb().insert(emailVerificationTokens).values({
    id: `tok_${uniq('v')}`,
    userId,
    tokenHash: hash,
    purpose: 'email_verification',
    expiresAt,
  });
}

async function insertPasswordReset(userId: string, hash: string, expiresAt: Date): Promise<void> {
  await getDb().insert(passwordResetTokens).values({
    id: `tok_${uniq('p')}`,
    userId,
    tokenHash: hash,
    purpose: 'password_reset',
    expiresAt,
  });
}

async function insertEmailChange(
  userId: string,
  hash: string,
  newEmail: string,
  expiresAt: Date,
): Promise<void> {
  await getDb().insert(emailChangeRequests).values({
    id: `tok_${uniq('c')}`,
    userId,
    tokenHash: hash,
    purpose: 'email_change',
    newEmail,
    expiresAt,
  });
}

beforeEach(async () => {
  // レート制限等の実 DB 共有テーブルの汚染は本テストでは扱わない（fileParallelism: false）。
});

afterAll(async () => {
  const db = getDb();
  for (const id of createdUserIds.splice(0)) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, id));
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, id));
    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Security - Token Reuse Prevention (D-16, real DB)', () => {
  it('有効な email_verification トークンは 1 回だけ消費でき、2 回目は invalid', async () => {
    const userId = await makeUser();
    const hash = hashToken(`raw-${uniq('ev')}`);
    await insertVerification(userId, hash, future());

    const first = await verifyAndConsumeToken(hash, 'email_verification');
    expect(first.valid).toBe(true);
    expect(first.userId).toBe(userId);

    const second = await verifyAndConsumeToken(hash, 'email_verification');
    expect(second.valid).toBe(false);
  });

  it('期限切れ email_verification トークンは消費できない', async () => {
    const userId = await makeUser();
    const hash = hashToken(`raw-${uniq('ev')}`);
    await insertVerification(userId, hash, past());

    const result = await verifyAndConsumeToken(hash, 'email_verification');
    expect(result.valid).toBe(false);

    // 期限切れは used_at を立てない（後から使えてもいけないが、無駄な更新もしない）
    const rows = await getDb()
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, hash));
    expect(rows[0]?.usedAt ?? null).toBeNull();
  });

  it('未知の email_verification トークンは invalid', async () => {
    const result = await verifyAndConsumeToken(hashToken('does-not-exist'), 'email_verification');
    expect(result.valid).toBe(false);
  });

  it('email_change トークンは newEmail を返して消費する', async () => {
    const userId = await makeUser();
    const hash = hashToken(`raw-${uniq('ec')}`);
    const newEmail = `${uniq('new')}@example.com`;
    await insertEmailChange(userId, hash, newEmail, future());

    const result = await verifyAndConsumeToken(hash, 'email_change');
    expect(result.valid).toBe(true);
    expect(result.userId).toBe(userId);
    expect(result.newEmail).toBe(newEmail);

    const second = await verifyAndConsumeToken(hash, 'email_change');
    expect(second.valid).toBe(false);
  });

  it('email_verification と password_reset は別テーブル（用途混同しない）', async () => {
    const userId = await makeUser();
    const hash = hashToken(`raw-${uniq('mix')}`);
    await insertPasswordReset(userId, hash, future());

    // password_reset にだけ存在する hash を email_verification として渡しても通らない
    const result = await verifyAndConsumeToken(hash, 'email_verification');
    expect(result.valid).toBe(false);

    const correct = await verifyAndConsumeToken(hash, 'password_reset');
    expect(correct.valid).toBe(true);
  });

  it('同一トークンへの並行消費は 1 本だけ成功する（TOCTOU 回帰）', async () => {
    const userId = await makeUser();
    const hash = hashToken(`raw-${uniq('race')}`);
    await insertVerification(userId, hash, future());

    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyAndConsumeToken(hash, 'email_verification')),
    );
    const succeeded = results.filter((r) => r.valid).length;
    expect(succeeded).toBe(1);
  });

  it('同一 password_reset トークンへの並行消費は 1 本だけ成功する（TOCTOU 回帰）', async () => {
    const userId = await makeUser();
    const hash = hashToken(`raw-${uniq('racep')}`);
    await insertPasswordReset(userId, hash, future());

    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyAndConsumeToken(hash, 'password_reset')),
    );
    expect(results.filter((r) => r.valid).length).toBe(1);
  });
});
