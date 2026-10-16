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
});
