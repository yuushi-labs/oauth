import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  emailVerificationTokens,
  passwordResetTokens,
  emailChangeRequests,
} from '@/lib/db/schema';

export type TokenPurpose = 'email_verification' | 'password_reset' | 'email_change';

type VerifyTokenResult = {
  valid: boolean;
  userId: string | null;
  newEmail: string | null;
  reason?: 'not_found' | 'expired' | 'already_used' | 'purpose_mismatch';
};

/**
 * トークンを**消費する**。`valid` が false なら失敗（= 不一致 / 期限切れ / 消費済み）。
 *
 * 消費は `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING` の更新行数で
 * 判定する（D-16）。read → 判定 → write の 2 段書きにすると、並行リクエストが同じ行を
 * 未消費と観測して全員が成功してしまう（TOCTOU）。単文 UPDATE にすることで、同一
 * トークンを同時に送っても成功するのは 1 リクエストだけになる。
 */
export async function verifyAndConsumeToken(
  tokenHash: string,
  purpose: TokenPurpose,
): Promise<VerifyTokenResult> {
  const db = getDb();
  const now = new Date();

  if (purpose === 'email_verification') {
    const rows = await db
      .update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, now),
        ),
      )
      .returning({ userId: emailVerificationTokens.userId });
    if (rows.length !== 1) return { valid: false, userId: null, newEmail: null };
    return { valid: true, userId: rows[0]!.userId, newEmail: null };
  }

  if (purpose === 'password_reset') {
    const rows = await db
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    if (rows.length !== 1) return { valid: false, userId: null, newEmail: null };
    return { valid: true, userId: rows[0]!.userId, newEmail: null };
  }

  const rows = await db
    .update(emailChangeRequests)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailChangeRequests.tokenHash, tokenHash),
        isNull(emailChangeRequests.usedAt),
        gt(emailChangeRequests.expiresAt, now),
      ),
    )
    .returning({ userId: emailChangeRequests.userId, newEmail: emailChangeRequests.newEmail });
  if (rows.length !== 1) return { valid: false, userId: null, newEmail: null };
  return { valid: true, userId: rows[0]!.userId, newEmail: rows[0]!.newEmail };
}
