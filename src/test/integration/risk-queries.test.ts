import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { securityEvents } from '@/lib/db/schema';
import { countDistinctRecentIpHashes, countRecentFailedLogins } from '@/lib/db/queries/security-events';
import { makeFixtureUser, cleanupFixtureUsers, type FixtureUser } from '@/test/helpers/fixtures';

/**
 * §57 のリスク判定が使う集計クエリ（P8-A-03）。
 *
 * 「短時間に複数 IP」は `security_events.ip` の **distinct 件数**で、
 * 「大量ログイン試行」は `login_failed` の件数で近似する（D-38-01）。
 * 実 PostgreSQL で、重複除外・イベント種の絞り込み・ウィンドウ境界を固定する。
 */
let user: FixtureUser;
const extraUsers: string[] = [];

const MINUTE = 60_000;

async function seedEvent(
  eventType: string,
  ip: string | null,
  createdAt: Date,
): Promise<void> {
  await getDb().insert(securityEvents).values({
    id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    userId: user.id,
    eventType,
    ip,
    ipMasked: ip ? `${ip.slice(0, 8)}xxx` : null,
    createdAt,
  });
}

// 各テストを独立させるため、ユーザーは毎回作り直す（イベント集計が前のテストに汚染されない）。
beforeEach(async () => {
  user = await makeFixtureUser();
});

afterEach(async () => {
  await cleanupFixtureUsers([user.id, ...extraUsers.splice(0)]);
});

describe('Risk queries (§57 / P8-A-03)', () => {
  it('countDistinctRecentIpHashes は重複を除いた件数を返す', async () => {
    const now = new Date();
    await seedEvent('login_success', 'iphash-a', now);
    await seedEvent('login_success', 'iphash-a', now);
    await seedEvent('login_success', 'iphash-b', now);
    await seedEvent('login_failed', 'iphash-c', now);
    // ip が null の行は数えない。
    await seedEvent('logout', null, now);

    expect(await countDistinctRecentIpHashes(user.id, 60 * MINUTE)).toBe(3);
  });

  it('countRecentFailedLogins は login_failed だけを数える', async () => {
    const now = new Date();
    await seedEvent('login_failed', 'iphash-x', now);
    await seedEvent('login_failed', 'iphash-x', now);
    await seedEvent('login_failed', 'iphash-x', now);
    await seedEvent('login_success', 'iphash-x', now);
    await seedEvent('logout', 'iphash-x', now);

    expect(await countRecentFailedLogins(user.id, 60 * MINUTE)).toBe(3);
  });

  it('★ ウィンドウ外の行は数えない', async () => {
    const old = new Date(Date.now() - 30 * MINUTE);
    await seedEvent('login_failed', 'iphash-old', old);
    await seedEvent('login_success', 'iphash-old', old);

    // 直近 10 分には入らない。
    expect(await countRecentFailedLogins(user.id, 10 * MINUTE)).toBe(0);
    expect(await countDistinctRecentIpHashes(user.id, 10 * MINUTE)).toBe(0);
    // 60 分ウィンドウなら入る。
    expect(await countRecentFailedLogins(user.id, 60 * MINUTE)).toBe(1);
    expect(await countDistinctRecentIpHashes(user.id, 60 * MINUTE)).toBe(1);
  });

  it('他ユーザーの行は数えない', async () => {
    const other = await makeFixtureUser();
    extraUsers.push(other.id);
    await getDb().insert(securityEvents).values({
      id: `evt_${Math.random().toString(36).slice(2, 12)}`,
      userId: other.id,
      eventType: 'login_failed',
      ip: 'iphash-other',
      createdAt: new Date(),
    });
    expect(await countRecentFailedLogins(other.id, 60 * MINUTE)).toBe(1);
    expect(await countRecentFailedLogins(user.id, 60 * MINUTE)).toBe(0);
  });
});
