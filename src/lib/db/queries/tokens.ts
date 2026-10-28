import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  emailVerificationTokens,
  passwordResetTokens,
  emailChangeRequests,
  accountDeletionRequests,
  type EmailVerificationToken,
  type PasswordResetToken,
  type EmailChangeRequest,
  type AccountDeletionRequest,
} from '@/lib/db/schema';

export async function insertEmailVerificationToken(
  data: { id: string; userId: string; tokenHash: string; purpose: string; expiresAt: Date },
): Promise<EmailVerificationToken> {
  const db = getDb();
  const [row] = await db.insert(emailVerificationTokens).values(data).returning();
  return row!;
}

export async function findEmailVerificationTokenByHash(
  tokenHash: string,
): Promise<EmailVerificationToken | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function invalidateEmailVerificationTokens(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));
}

export async function insertPasswordResetToken(
  data: { id: string; userId: string; tokenHash: string; purpose: string; expiresAt: Date },
): Promise<PasswordResetToken> {
  const db = getDb();
  const [row] = await db.insert(passwordResetTokens).values(data).returning();
  return row!;
}

export async function findPasswordResetTokenByHash(
  tokenHash: string,
): Promise<PasswordResetToken | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function invalidatePasswordResetTokens(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

export async function insertEmailChangeRequest(
  data: { id: string; userId: string; tokenHash: string; purpose: string; newEmail: string; expiresAt: Date },
): Promise<EmailChangeRequest> {
  const db = getDb();
  const [row] = await db.insert(emailChangeRequests).values(data).returning();
  return row!;
}

export async function findEmailChangeRequestByHash(
  tokenHash: string,
): Promise<EmailChangeRequest | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(emailChangeRequests)
    .where(eq(emailChangeRequests.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function invalidateEmailChangeRequests(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(emailChangeRequests)
    .set({ usedAt: new Date() })
    .where(and(eq(emailChangeRequests.userId, userId), isNull(emailChangeRequests.usedAt)));
}

export async function markEmailChangeNotified(tokenHash: string): Promise<void> {
  const db = getDb();
  await db
    .update(emailChangeRequests)
    .set({ oldEmailNotifiedAt: new Date() })
    .where(eq(emailChangeRequests.tokenHash, tokenHash));
}

export async function insertAccountDeletionRequest(
  data: { id: string; userId: string; tokenHash: string; purpose: string; expiresAt: Date },
): Promise<AccountDeletionRequest> {
  const db = getDb();
  const [row] = await db.insert(accountDeletionRequests).values(data).returning();
  return row!;
}

export async function invalidateAccountDeletionRequests(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(accountDeletionRequests)
    .set({ usedAt: new Date() })
    .where(and(eq(accountDeletionRequests.userId, userId), isNull(accountDeletionRequests.usedAt)));
}

export async function invalidateAllUserTokens(userId: string): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt)));
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    await tx
      .update(emailChangeRequests)
      .set({ usedAt: new Date() })
      .where(and(eq(emailChangeRequests.userId, userId), isNull(emailChangeRequests.usedAt)));
    await tx
      .update(accountDeletionRequests)
      .set({ usedAt: new Date() })
      .where(and(eq(accountDeletionRequests.userId, userId), isNull(accountDeletionRequests.usedAt)));
  });
}