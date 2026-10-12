import { eq } from 'drizzle-orm';
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

export async function verifyAndConsumeToken(
  tokenHash: string,
  purpose: TokenPurpose,
): Promise<VerifyTokenResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    if (purpose === 'email_verification') {
      const [row] = await tx
        .select()
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.tokenHash, tokenHash))
        .limit(1);
      if (!row) return { valid: false, userId: null, newEmail: null, reason: 'not_found' };
      if (row.usedAt) return { valid: false, userId: null, newEmail: null, reason: 'already_used' };
      if (!(row.expiresAt.getTime() > Date.now())) return { valid: false, userId: null, newEmail: null, reason: 'expired' };
      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokens.id, row.id));
      return { valid: true, userId: row.userId, newEmail: null };
    }
    if (purpose === 'password_reset') {
      const [row] = await tx
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))
        .limit(1);
      if (!row) return { valid: false, userId: null, newEmail: null, reason: 'not_found' };
      if (row.usedAt) return { valid: false, userId: null, newEmail: null, reason: 'already_used' };
      if (!(row.expiresAt.getTime() > Date.now())) return { valid: false, userId: null, newEmail: null, reason: 'expired' };
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, row.id));
      return { valid: true, userId: row.userId, newEmail: null };
    }
    // email_change
    const [row] = await tx
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.tokenHash, tokenHash))
      .limit(1);
    if (!row) return { valid: false, userId: null, newEmail: null, reason: 'not_found' };
    if (row.usedAt) return { valid: false, userId: null, newEmail: null, reason: 'already_used' };
    if (!(row.expiresAt.getTime() > Date.now())) return { valid: false, userId: null, newEmail: null, reason: 'expired' };
    await tx
      .update(emailChangeRequests)
      .set({ usedAt: new Date() })
      .where(eq(emailChangeRequests.id, row.id));
    return { valid: true, userId: row.userId, newEmail: row.newEmail };
  });
}