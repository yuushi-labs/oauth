import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db/client';
import { securityEvents } from '@/lib/db/schema';
import {
  countRecentEventsByType,
  countRecentFailedEventTypes,
} from '@/lib/db/queries/security-events';
import { makeFixtureUser, cleanupFixtureUsers, type FixtureUser } from '@/test/helpers/fixtures';

/**
 * 監視アラートが使う集計クエリ（Phase 9 / P9-A-05）。
 *
 * `countRecentEventsByType` はユーザー横断の件数、`countRecentFailedEventTypes` は
 * `*_failed` 系の合計を返す。実 PostgreSQL でウィンドウ境界と種別の絞り込みを固定する。
 */

let user: FixtureUser;
const extraUsers: string[] = [];
const MINUTE = 60_000;

async function seedEvent(eventType: string, createdAt: Date): Promise<void> {
  await getDb().insert(securityEvents).values({
    id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    userId: user.id,
    eventType,
    ip: 'iphash-x',
    createdAt,
  });
}

beforeEach(async () => {
  user = await makeFixtureUser();
});

afterEach(async () => {
  await cleanupFixtureUsers([user.id, ...extraUsers.splice(0)]);
});

describe('Phase 9 - alert queries', () => {
  it('counts events by type across users within the window', async () => {
    const now = new Date();
    const failedBefore = await countRecentEventsByType('login_failed', 10 * MINUTE);
    const successBefore = await countRecentEventsByType('login_success', 10 * MINUTE);
    await seedEvent('login_failed', now);
    await seedEvent('login_failed', now);
    await seedEvent('login_success', now);

    expect(await countRecentEventsByType('login_failed', 10 * MINUTE)).toBe(failedBefore + 2);
    expect(await countRecentEventsByType('login_success', 10 * MINUTE)).toBe(successBefore + 1);
  });

  it('does not count events outside the window', async () => {
    const before10 = await countRecentEventsByType('rate_limited', 10 * MINUTE);
    const before60 = await countRecentEventsByType('rate_limited', 60 * MINUTE);
    await seedEvent('rate_limited', new Date(Date.now() - 30 * MINUTE));
    // 30 分前の 1 行は 10 分ウィンドウに入らない。
    expect(await countRecentEventsByType('rate_limited', 10 * MINUTE)).toBe(before10);
    // 60 分ウィンドウなら入る。
    expect(await countRecentEventsByType('rate_limited', 60 * MINUTE)).toBe(before60 + 1);
  });

  it('counts only *_failed events for server errors', async () => {
    const now = new Date();
    // 集計はユーザー横断なので、他テストの残存行に影響されないよう差分で確認する。
    const before = await countRecentFailedEventTypes(10 * MINUTE);
    await seedEvent('login_failed', now);
    await seedEvent('oidc_token_failed', now);
    await seedEvent('security_notification_failed', now);
    await seedEvent('login_success', now);

    expect(await countRecentFailedEventTypes(10 * MINUTE)).toBe(before + 3);
  });

  it('returns the same count when nothing new is added', async () => {
    // 集計はユーザー横断なので、対象ウィンドウに何も足していないことを差分で確認する。
    const before = await countRecentEventsByType('rate_limited', 10 * MINUTE);
    expect(await countRecentEventsByType('rate_limited', 10 * MINUTE)).toBe(before);
  });
});
