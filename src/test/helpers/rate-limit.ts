import type {
  FailedAttemptReservation,
  RateLimitResult,
  ReservationResult,
} from '@/lib/auth/rate-limit';
import { protectRateLimitKey } from '@/lib/auth/rate-limit-keys';

/**
 * `rateLimiter` の**インメモリ代替**（D-38-06）。
 *
 * 実装（PostgreSQL）は正しいが、テストが固定したいのは「上限を超えたら拒否する」という
 * 契約であって DB のロック挙動ではない。時間依存を `vi.useFakeTimers()` で制御できるよう、
 * 時計は `Date.now()` を都度読む。
 *
 * 使い方:
 *   const limiter = createFakeRateLimiter();
 *   vi.mock('@/lib/auth/rate-limit', () => ({ rateLimiter: limiter }));
 */
export type FakeRateLimiter = {
  check: (key: string, windowMs: number, max: number, softLimit?: number) => Promise<RateLimitResult>;
  reserveFailedAttempt: (key: string, windowMs: number, max: number, softLimit: number) => Promise<ReservationResult>;
  releaseReservation: (reservation: FailedAttemptReservation) => Promise<void>;
  finishFailedAttempt: (reservation: FailedAttemptReservation, success: boolean) => Promise<boolean>;
  /** テスト用: 記録を消す。 */
  reset: () => void;
  /** テスト用: 現在の失敗カウントを覗く。 */
  countOf: (key: string) => number;
};

type Counter = { count: number; expiresAt: number; generation: number };

export function createFakeRateLimiter(): FakeRateLimiter {
  const counters = new Map<string, Counter>();
  const reservations = new Map<string, { key: string; generation: number; active: boolean }>();
  let reservationSeq = 0;

  function counterFor(key: string, windowMs: number): Counter {
    const storageKey = protectRateLimitKey(key);
    const now = Date.now();
    let counter = counters.get(storageKey);
    if (!counter || counter.expiresAt <= now) {
      counter = { count: 0, expiresAt: now + windowMs, generation: (counter?.generation ?? 0) + 1 };
      counters.set(storageKey, counter);
    }
    return counter;
  }

  return {
    async check(key, windowMs, max, softLimit = max) {
      const storageKey = protectRateLimitKey(key);
      const counter = counterFor(key, windowMs);
      counter.count += 1;
      const count = counter.count;
      return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        resetAt: counter.expiresAt,
        count,
        captchaRequired: count >= softLimit,
        logRateLimited: count === max + 1,
      };
    },

    async reserveFailedAttempt(key, windowMs, max, softLimit) {
      const storageKey = protectRateLimitKey(key);
      const counter = counterFor(key, windowMs);
      const active = [...reservations.values()].filter(
        (r) => r.key === storageKey && r.generation === counter.generation && r.active,
      ).length;
      if (counter.count + active >= max) {
        return { allowed: false, count: counter.count + active, resetAt: counter.expiresAt, logRateLimited: false };
      }
      reservationSeq += 1;
      const reservationId = `res_${reservationSeq}`;
      reservations.set(reservationId, { key: storageKey, generation: counter.generation, active: true });
      return {
        allowed: true,
        reservation: {
          reservationId,
          key: storageKey,
          generation: counter.generation,
          captchaRequired: counter.count >= softLimit,
          resetAt: counter.expiresAt,
        },
      };
    },

    async releaseReservation(reservation) {
      const row = reservations.get(reservation.reservationId);
      if (row) row.active = false;
    },

    async finishFailedAttempt(reservation, success) {
      const row = reservations.get(reservation.reservationId);
      if (!row || !row.active) return false;
      row.active = false;
      if (success) {
        const counter = counters.get(reservation.key);
        if (counter && counter.generation === reservation.generation) counter.count = 0;
        return false;
      }
      const counter = counters.get(reservation.key);
      if (counter && counter.generation === reservation.generation) counter.count += 1;
      return counter?.count === 5;
    },

    reset() {
      counters.clear();
      reservations.clear();
      reservationSeq = 0;
    },

    countOf(key) {
      return counters.get(protectRateLimitKey(key))?.count ?? 0;
    },
  };
}
