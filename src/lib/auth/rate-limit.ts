import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { rateLimitHits, rateLimitReservations } from '@/lib/db/schema';
import { protectRateLimitKey } from '@/lib/auth/rate-limit-keys';

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  count: number;
  captchaRequired: boolean;
  logRateLimited: boolean;
};

export type FailedAttemptReservation = {
  reservationId: string;
  key: string;
  generation: number;
  captchaRequired: boolean;
  resetAt: number;
};

export type ReservationResult =
  | { allowed: true; reservation: FailedAttemptReservation }
  | { allowed: false; count: number; resetAt: number; logRateLimited: boolean };

function getSqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return getSqlState(error.cause);
  return null;
}

const SERIALIZABLE_MAX_ATTEMPTS = 5;

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);

/**
 * Runs a reservation transaction and retries serialization failures.
 *
 * The counter row is locked with `FOR UPDATE`, which is what the algorithm needs to keep the hard
 * limit strict. Isolation is REPEATABLE READ rather than SERIALIZABLE because SERIALIZABLE adds
 * predicate locks whose range conflicts abort unrelated keys (SQLSTATE 40001), which surfaced as 500
 * responses on login. Deadlocks and any residual 40001 are still retried with backoff.
 */
async function runSerializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!RETRYABLE_SQL_STATES.has(getSqlState(error) ?? '') || attempt >= SERIALIZABLE_MAX_ATTEMPTS - 1) throw error;
      const backoff = 10 * 2 ** attempt + Math.floor(Math.random() * 10);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

/** PostgreSQL is the authoritative store so backend outages fail closed, never open. */
export class RateLimiter {
  async check(key: string, windowMs: number, max: number, softLimit = max): Promise<RateLimitResult> {
    const db = getDb();
    const now = new Date();
    const proposedExpiry = new Date(now.getTime() + windowMs);
    const storageKey = protectRateLimitKey(key);
    const [row] = await db.insert(rateLimitHits).values({
      key: storageKey,
      failedCount: 1,
      windowExpiresAt: proposedExpiry,
    }).onConflictDoUpdate({
      target: rateLimitHits.key,
      set: {
        generation: sql`CASE WHEN ${rateLimitHits.windowExpiresAt} <= ${now} THEN ${rateLimitHits.generation} + 1 ELSE ${rateLimitHits.generation} END`,
        failedCount: sql`CASE WHEN ${rateLimitHits.windowExpiresAt} <= ${now} THEN 1 ELSE ${rateLimitHits.failedCount} + 1 END`,
        windowExpiresAt: sql`CASE WHEN ${rateLimitHits.windowExpiresAt} <= ${now} THEN ${proposedExpiry} ELSE ${rateLimitHits.windowExpiresAt} END`,
      },
    }).returning({ count: rateLimitHits.failedCount, expires: rateLimitHits.windowExpiresAt });

    const count = row?.count ?? 1;
    const resetAt = row?.expires.getTime() ?? proposedExpiry.getTime();
    const allowed = count <= max;
    return {
      allowed,
      remaining: Math.max(0, max - count),
      resetAt,
      count,
      captchaRequired: count >= softLimit,
      logRateLimited: count === max + 1,
    };
  }

  async reserveFailedAttempt(
    key: string,
    windowMs: number,
    max: number,
    softLimit: number,
  ): Promise<ReservationResult> {
    const db = getDb();
    const storageKey = protectRateLimitKey(key);
    const now = new Date();
    const expiry = new Date(now.getTime() + windowMs);

    return runSerializable(async () => db.transaction(async (tx) => {
      await tx.insert(rateLimitHits).values({
        key: storageKey,
        failedCount: 0,
        windowExpiresAt: expiry,
      }).onConflictDoNothing();

      let [hit] = await tx.select().from(rateLimitHits).where(eq(rateLimitHits.key, storageKey)).for('update').limit(1);
      if (!hit) throw new Error('Rate limit counter could not be initialized');
      if (hit.windowExpiresAt.getTime() <= now.getTime()) {
        const [updated] = await tx.update(rateLimitHits).set({
          generation: hit.generation + 1,
          failedCount: 0,
          windowExpiresAt: expiry,
        }).where(eq(rateLimitHits.key, storageKey)).returning();
        hit = updated ?? hit;
      }

      const [active] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(rateLimitReservations)
        .where(and(
          eq(rateLimitReservations.key, storageKey),
          eq(rateLimitReservations.generation, hit.generation),
          eq(rateLimitReservations.status, 'active'),
        ));
      const activeCount = Number(active?.count ?? 0);
      const inFlightAndFailed = hit.failedCount + activeCount;
      if (inFlightAndFailed >= max) {
        return {
          allowed: false as const,
          count: inFlightAndFailed,
          resetAt: hit.windowExpiresAt.getTime(),
          logRateLimited: false,
        };
      }

      const [reservation] = await tx.insert(rateLimitReservations).values({
        key: storageKey,
        generation: hit.generation,
        expiresAt: new Date(hit.windowExpiresAt.getTime() + 30_000),
      }).returning({ reservationId: rateLimitReservations.reservationId });
      if (!reservation) throw new Error('Rate limit reservation could not be created');
      return {
        allowed: true as const,
        reservation: {
          reservationId: reservation.reservationId,
          key: storageKey,
          generation: hit.generation,
          captchaRequired: hit.failedCount >= softLimit,
          resetAt: hit.windowExpiresAt.getTime(),
        },
      };
    }, { isolationLevel: 'repeatable read' }));
  }

  async releaseReservation(reservation: FailedAttemptReservation): Promise<void> {
    const db = getDb();
    await db.update(rateLimitReservations).set({ status: 'released', releasedAt: new Date() })
      .where(and(
        eq(rateLimitReservations.reservationId, reservation.reservationId),
        eq(rateLimitReservations.status, 'active'),
      ));
  }

  async finishFailedAttempt(reservation: FailedAttemptReservation, success: boolean): Promise<boolean> {
    const db = getDb();
    return runSerializable(async () => db.transaction(async (tx) => {
      const [locked] = await tx.select().from(rateLimitReservations)
        .where(eq(rateLimitReservations.reservationId, reservation.reservationId))
        .for('update').limit(1);
      if (!locked || locked.status !== 'active') return false;
      const now = new Date();
      await tx.update(rateLimitReservations).set(success
        ? { status: 'released', releasedAt: now }
        : { status: 'confirmed', confirmedAt: now })
        .where(and(
          eq(rateLimitReservations.reservationId, reservation.reservationId),
          eq(rateLimitReservations.status, 'active'),
        ));
      if (success) {
        await tx.update(rateLimitHits).set({ failedCount: 0 })
          .where(and(eq(rateLimitHits.key, reservation.key), eq(rateLimitHits.generation, reservation.generation)));
      } else {
        const [updated] = await tx.update(rateLimitHits).set({ failedCount: sql`${rateLimitHits.failedCount} + 1` })
          .where(and(eq(rateLimitHits.key, reservation.key), eq(rateLimitHits.generation, reservation.generation)))
          .returning({ failedCount: rateLimitHits.failedCount });
        return updated?.failedCount === 5;
      }
      return false;
    }, { isolationLevel: 'repeatable read' }));
  }
}

export const rateLimiter = new RateLimiter();
