import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import {
  emailVerificationTokens,
  passwordResetTokens,
  emailChangeRequests,
} from '@/lib/db/schema';
import { generateToken } from '@/lib/auth/tokens/generate';
import { createUser, softDeleteUser } from '@/lib/db/queries/users';

/**
 * Security - Token Reuse Prevention（実 PostgreSQL）
 *
 * 使い切りは「単文の条件付き UPDATE の更新行数」で判定する（D-16）。モックで
 * 原子性を模擬すると競合を検出できないため、実 DB に対して検証する。
 */

const createdUsers: string[] = [];

let seq = 0;
async function newUser(tag: string): Promise<string> {
  const id = `usr_${tag}${Date.now().toString(36)}${(seq += 1)}`;
  await createUser({
    id,
    email: `${id}@example.com`,
    username: id,
    emailVerified: true,
    status: 'active',
    roleId: 'role_user',
  });
  createdUsers.push(id);
  return id;
}

afterEach(async () => {
  const db = getDb();
  for (const userId of createdUsers) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, userId));
    await softDeleteUser(userId);
  }
  createdUsers.length = 0;
});

describe('Security - Token Reuse Prevention', () => {
  it('verifyAndConsumeToken consumes valid token', async () => {
    const userId = await newUser('consume');
    const { raw, hash, id } = generateToken();
    await getDb().insert(emailVerificationTokens).values({
      id, userId, tokenHash: hash, purpose: 'email_verification',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const result = await verifyAndConsumeToken(hash, 'email_verification');
    expect(result.valid).toBe(true);
    expect(result.userId).toBe(userId);
    expect(raw.length).toBeGreaterThanOrEqual(43);
  });

  it('verifyAndConsumeToken rejects already consumed token', async () => {
    const userId = await newUser('reuse');
    const { hash, id } = generateToken();
    await getDb().insert(emailVerificationTokens).values({
      id, userId, tokenHash: hash, purpose: 'email_verification',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect((await verifyAndConsumeToken(hash, 'email_verification')).valid).toBe(true);
    expect((await verifyAndConsumeToken(hash, 'email_verification')).valid).toBe(false);
  });

  it('verifyAndConsumeToken rejects expired token', async () => {
    const userId = await newUser('expired');
    const { hash, id } = generateToken();
    await getDb().insert(emailVerificationTokens).values({
      id, userId, tokenHash: hash, purpose: 'email_verification',
      expiresAt: new Date(Date.now() - 3_600_000),
    });

    expect((await verifyAndConsumeToken(hash, 'email_verification')).valid).toBe(false);
  });

  it('verifyAndConsumeToken returns invalid for non-existent token', async () => {
    const result = await verifyAndConsumeToken('deadbeef'.repeat(8), 'email_verification');
    expect(result.valid).toBe(false);
  });

  it('concurrent consume attempts only succeed once', async () => {
    const userId = await newUser('race');
    const { hash, id } = generateToken();
    await getDb().insert(emailVerificationTokens).values({
      id, userId, tokenHash: hash, purpose: 'email_verification',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyAndConsumeToken(hash, 'email_verification')),
    );
    expect(results.filter((r) => r.valid)).toHaveLength(1);
  });

  it('concurrent password_reset consume attempts only succeed once', async () => {
    const userId = await newUser('race-pr');
    const { hash, id } = generateToken();
    await getDb().insert(passwordResetTokens).values({
      id, userId, tokenHash: hash, purpose: 'password_reset',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyAndConsumeToken(hash, 'password_reset')),
    );
    expect(results.filter((r) => r.valid)).toHaveLength(1);
  });

  it('concurrent email_change consume attempts only succeed once and return newEmail', async () => {
    const userId = await newUser('race-ec');
    const { hash, id } = generateToken();
    await getDb().insert(emailChangeRequests).values({
      id, userId, tokenHash: hash, purpose: 'email_change',
      newEmail: 'changed@example.com',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyAndConsumeToken(hash, 'email_change')),
    );
    const valid = results.filter((r) => r.valid);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.newEmail).toBe('changed@example.com');
  });
});
