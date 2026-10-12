import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  sessions,
  type NewSession,
  type Session,
} from '@/lib/db/schema';

export async function insertSession(data: NewSession): Promise<Session> {
  const db = getDb();
  const [row] = await db.insert(sessions).values(data).returning();
  return row!;
}

export async function findSessionByHash(sessionHash: string): Promise<Session | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.sessionHash, sessionHash))
    .limit(1);
  return row ?? null;
}

export async function updateLastSeen(id: string, now: Date): Promise<void> {
  const db = getDb();
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
}

export async function revokeSession(id: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(eq(sessions.id, id));
}

export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function updateReauthVerified(id: string): Promise<void> {
  const db = getDb();
  await db.update(sessions).set({ reauthVerifiedAt: new Date() }).where(eq(sessions.id, id));
}