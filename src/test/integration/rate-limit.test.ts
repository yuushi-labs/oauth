import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db/client';
import { rateLimitHits } from '@/lib/db/schema';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { protectRateLimitKey } from '@/lib/auth/rate-limit-keys';

const logicalKey = `test:phase2:reservation:${crypto.randomUUID()}`;
const storedKey = protectRateLimitKey(logicalKey);

afterEach(async () => {
  await getDb().delete(rateLimitHits).where(eq(rateLimitHits.key, storedKey));
});

afterAll(async () => {
  await getPool().end();
});

describe('Phase 2 PostgreSQL rate-limit reservations', () => {
  it('reserves concurrent slots, rejects at the hard limit, and resets only on success', async () => {
    const options = [logicalKey, 60_000, 2, 1] as const;
    const [first, second] = await Promise.all([
      rateLimiter.reserveFailedAttempt(...options),
      rateLimiter.reserveFailedAttempt(...options),
    ]);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) throw new Error('Expected two reservations');

    const full = await rateLimiter.reserveFailedAttempt(...options);
    expect(full.allowed).toBe(false);

    await rateLimiter.finishFailedAttempt(first.reservation, false);
    const stillFull = await rateLimiter.reserveFailedAttempt(...options);
    expect(stillFull.allowed).toBe(false);

    await rateLimiter.finishFailedAttempt(second.reservation, true);
    const afterSuccess = await rateLimiter.reserveFailedAttempt(...options);
    expect(afterSuccess.allowed).toBe(true);
    if (afterSuccess.allowed) await rateLimiter.releaseReservation(afterSuccess.reservation);
  });

  it('completes concurrent reservations across distinct keys without serialization failures', async () => {
    // Login reserves several keys in parallel. SERIALIZABLE predicate-lock conflicts must be
    // retried internally instead of surfacing as a 500 (regression: finishFailedAttempt threw).
    const keys = Array.from({ length: 4 }, () => `test:phase2:parallel:${crypto.randomUUID()}`);
    const storedKeys = keys.map(protectRateLimitKey);
    try {
      const results = await Promise.all(keys.map((key) => rateLimiter.reserveFailedAttempt(key, 60_000, 5, 2)));
      expect(results.every((result) => result.allowed)).toBe(true);
      const reservations = results.flatMap((result) => (result.allowed ? [result.reservation] : []));
      await expect(Promise.all(reservations.map((reservation) => rateLimiter.finishFailedAttempt(reservation, true))))
        .resolves.toHaveLength(reservations.length);
    } finally {
      await getDb().delete(rateLimitHits).where(eq(rateLimitHits.key, storedKeys[0]!));
      for (const storedKey of storedKeys) {
        await getPool().query('DELETE FROM rate_limit_hits WHERE key = $1', [storedKey]);
      }
    }
  });
});
