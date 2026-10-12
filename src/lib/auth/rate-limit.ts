import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { rateLimitHits } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import type Redis from 'ioredis';

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

class PgRateLimiter {
  async check(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowExpiresAt = new Date(now + windowMs);

    const db = getDb();
    const result = await db
      .insert(rateLimitHits)
      .values({ key, count: 1, windowExpiresAt })
      .onConflictDoUpdate({
        target: rateLimitHits.key,
        set: {
          count: sql`CASE
            WHEN ${rateLimitHits.windowExpiresAt} <= ${now} THEN 1
            ELSE ${rateLimitHits.count} + 1
          END`,
          windowExpiresAt: sql`CASE
            WHEN ${rateLimitHits.windowExpiresAt} <= ${now} THEN ${windowExpiresAt}
            ELSE ${rateLimitHits.windowExpiresAt}
          END`,
        },
      })
      .returning({ count: rateLimitHits.count, windowExpiresAt: rateLimitHits.windowExpiresAt });

    const row = result[0];
    if (!row) {
      return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
    }
    const count = row.count;
    const expiresAt = row.windowExpiresAt.getTime();

    if (count > max) {
      return { allowed: false, remaining: 0, resetAt: expiresAt };
    }

    return { allowed: true, remaining: max - count, resetAt: expiresAt };
  }
}

class RedisRateLimiter {
  private client: Redis | null = null;
  private connected = false;

  private async getClient() {
    if (this.client) return this.client;

    const env = getEnv();
    const redisUrl = env.REDIS_URL;
    if (!redisUrl) return null;

    try {
      const { Redis } = await import('ioredis');
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      await this.client.connect();
      this.connected = true;
      return this.client;
    } catch {
      this.connected = false;
      return null;
    }
  }

  async check(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const client = await this.getClient();
    if (!client) {
      return { allowed: true, remaining: max, resetAt: Date.now() + windowMs };
    }

    const now = Date.now();
    const windowSec = Math.ceil(windowMs / 1000);
    const redisKey = `rl:${key}`;

    try {
      const count = await client.eval(
        `local current = redis.call('INCR', KEYS[1])
         if current == 1 then
           redis.call('EXPIRE', KEYS[1], ARGV[1])
         end
         local ttl = redis.call('TTL', KEYS[1])
         return {current, ttl}`,
        1,
        redisKey,
        windowSec.toString(),
      ) as [number, number];

      const [currentCount, ttl] = count;
      const resetAt = now + ttl * 1000;

      if (currentCount > max) {
        return { allowed: false, remaining: 0, resetAt };
      }

      return { allowed: true, remaining: max - currentCount, resetAt };
    } catch {
      return { allowed: true, remaining: max, resetAt: now + windowMs };
    }
  }
}

export class RateLimiter {
  private pgLimiter = new PgRateLimiter();
  private redisLimiter = new RedisRateLimiter();
  private useRedis = false;

  constructor() {
    const env = getEnv();
    this.useRedis = !!env.REDIS_URL;
  }

  async check(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    if (this.useRedis) {
      const result = await this.redisLimiter.check(key, windowMs, max);
      if (!result.allowed) return result;
      if (result.remaining < max) return result;
    }
    return this.pgLimiter.check(key, windowMs, max);
  }
}

export const rateLimiter = new RateLimiter();