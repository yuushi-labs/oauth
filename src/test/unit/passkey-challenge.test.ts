import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { DEFAULT_ROLE_ID, users, webauthnChallenges } from '@/lib/db/schema';
import { createUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { CHALLENGE_TTL_MS, consumeChallenge, issueChallenge } from '@/lib/auth/passkey/challenge';

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
    await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('Passkey challenge (D-34-05)', () => {
  it('issueChallenge は wch_ の id と challenge を返し、TTL は 5 分', async () => {
    const userId = await makeUser();
    const { id, challenge } = await issueChallenge({ userId, type: 'registration' });
    expect(id.startsWith('wch_')).toBe(true);
    expect(challenge.length).toBeGreaterThanOrEqual(22);

    const db = getDb();
    const [row] = await db.select().from(webauthnChallenges).where(eq(webauthnChallenges.id, id));
    expect(row).toBeDefined();
    // `expires_at` は JS の Date.now() から、`created_at` は DB の defaultNow()（µs 精度）から
    // 入るため、差は TTL ちょうどにはならない。サブ秒のずれを許容して範囲で確認する。
    const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(ttl).toBeGreaterThan(CHALLENGE_TTL_MS - 1000);
    expect(ttl).toBeLessThanOrEqual(CHALLENGE_TTL_MS + 1000);
  });

  it('同じ challenge を 2 回消費すると 2 回目は null（1 回限り）', async () => {
    const userId = await makeUser();
    const { id } = await issueChallenge({ userId, type: 'registration' });
    const first = await consumeChallenge({ id, type: 'registration', userId });
    expect(first).not.toBeNull();
    const second = await consumeChallenge({ id, type: 'registration', userId });
    expect(second).toBeNull();
  });

  it('期限切れの challenge は消費できない', async () => {
    const userId = await makeUser();
    const { id } = await issueChallenge({ userId, type: 'registration' });
    const db = getDb();
    await db
      .update(webauthnChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(webauthnChallenges.id, id));
    expect(await consumeChallenge({ id, type: 'registration', userId })).toBeNull();
  });

  it('type が一致しない challenge は消費できない', async () => {
    const userId = await makeUser();
    const { id } = await issueChallenge({ userId, type: 'registration' });
    expect(await consumeChallenge({ id, type: 'authentication', userId })).toBeNull();
  });

  it('他人の user_id の challenge は消費できない', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { id } = await issueChallenge({ userId: owner, type: 'registration' });
    expect(await consumeChallenge({ id, type: 'registration', userId: other })).toBeNull();
  });

  it('user_id が null の challenge は誰でも（discoverable ログイン）消費できる', async () => {
    const { id } = await issueChallenge({ userId: null, type: 'authentication' });
    const consumed = await consumeChallenge({ id, type: 'authentication', userId: 'usr_anyone' });
    expect(consumed).not.toBeNull();
  });
});
