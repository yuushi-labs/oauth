import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { securityEvents } from '@/lib/db/schema';
import { RISK_LIMITS, RISK_THRESHOLDS, RISK_WEIGHTS } from '@/config/risk';
import {
  assessLoginRisk,
  decideRiskAction,
  detectSignals,
  isAutomatedClient,
  riskLevel,
  scoreRisk,
  type LoginRiskInput,
} from '@/lib/auth/risk';
import { evaluateAndRecordLoginRisk } from '@/lib/auth/login-risk';
import { cleanupFixtureUsers, fixtureSession, makeFixtureUser, persistFixtureSession, type FixtureUser } from '@/test/helpers/fixtures';

/**
 * §57 不審ログイン検知。判定は純関数（DB 非依存）で、I/O は `login-risk.ts` のラッパだけ。
 *
 * 既定 `RISK_ENFORCEMENT='notify'`（D-38-03）では、どれだけ高スコアでも `notify` を超えない。
 * 「短時間で複数地域」は外部 geo-IP ではなく短期間の複数 `ip_hash` で代理する（D-38-01）。
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

function input(overrides: Partial<LoginRiskInput> = {}): LoginRiskInput {
  return {
    ipHash: 'iphash-known',
    deviceName: 'Chrome on Windows',
    activeSessions: [{ ipHash: 'iphash-known', deviceName: 'Chrome on Windows' }],
    recentDistinctIpHashes: 1,
    recentFailedCount: 0,
    userAgent: CHROME_UA,
    ...overrides,
  };
}

describe('Security - risk scoring (§57)', () => {
  it('重みを合計する。同じ信号は 1 回だけ数える', () => {
    expect(scoreRisk([])).toBe(0);
    expect(scoreRisk(['new_device'])).toBe(RISK_WEIGHTS.new_device);
    expect(scoreRisk(['new_device', 'new_device'])).toBe(RISK_WEIGHTS.new_device);
    expect(scoreRisk(['new_device', 'new_ip'])).toBe(RISK_WEIGHTS.new_device + RISK_WEIGHTS.new_ip);
  });

  it('スコアを low / medium / high に写像する', () => {
    expect(riskLevel(0)).toBe('low');
    expect(riskLevel(RISK_THRESHOLDS.notify - 1)).toBe('low');
    expect(riskLevel(RISK_THRESHOLDS.notify)).toBe('medium');
    expect(riskLevel(RISK_THRESHOLDS.challenge)).toBe('high');
  });

  it('自動化 UA を検出する（空 UA も自動化扱い）', () => {
    expect(isAutomatedClient(CHROME_UA)).toBe(false);
    expect(isAutomatedClient('curl/8.4.0')).toBe(true);
    expect(isAutomatedClient('python-requests/2.31')).toBe(true);
    expect(isAutomatedClient('Googlebot/2.1')).toBe(true);
    expect(isAutomatedClient('')).toBe(true);
  });

  it('未知のデバイス・IP で new_device / new_ip を立てる', () => {
    const signals = detectSignals(input({ activeSessions: [] }));
    expect(signals).toContain('new_device');
    expect(signals).toContain('new_ip');
  });

  it('既知の (ip_hash, device_name) では new_device を立てない', () => {
    const signals = detectSignals(input());
    expect(signals).not.toContain('new_device');
    expect(signals).not.toContain('new_ip');
  });

  it('同一 IP だが別デバイスなら new_device のみ（new_ip は立たない）', () => {
    const signals = detectSignals(input({ deviceName: 'iPhone' }));
    expect(signals).toContain('new_device');
    expect(signals).not.toContain('new_ip');
  });

  it('短期間の複数 IP で rapid_distinct_ips を立てる（§57 の代理指標・D-38-01）', () => {
    expect(detectSignals(input({ recentDistinctIpHashes: RISK_LIMITS.distinctIps - 1 }))).not.toContain(
      'rapid_distinct_ips',
    );
    expect(detectSignals(input({ recentDistinctIpHashes: RISK_LIMITS.distinctIps }))).toContain(
      'rapid_distinct_ips',
    );
  });

  it('大量ログイン試行で failed_burst を立てる', () => {
    expect(detectSignals(input({ recentFailedCount: RISK_LIMITS.failedCount - 1 }))).not.toContain('failed_burst');
    expect(detectSignals(input({ recentFailedCount: RISK_LIMITS.failedCount }))).toContain('failed_burst');
  });

  it('自動化 UA で automated_client を立てる', () => {
    expect(detectSignals(input({ userAgent: 'curl/8.4.0' }))).toContain('automated_client');
  });
});

describe('Security - risk action mapping (§57 / D-38-02)', () => {
  it('閾値ごとに allow / notify / challenge / hold へ写像する（enforcement=hold）', () => {
    expect(decideRiskAction(RISK_THRESHOLDS.notify - 1, 'hold')).toBe('allow');
    expect(decideRiskAction(RISK_THRESHOLDS.notify, 'hold')).toBe('notify');
    expect(decideRiskAction(RISK_THRESHOLDS.challenge, 'hold')).toBe('challenge');
    expect(decideRiskAction(RISK_THRESHOLDS.hold, 'hold')).toBe('hold');
  });

  it('enforcement はアクションの上限として働く', () => {
    expect(decideRiskAction(RISK_THRESHOLDS.hold + 100, 'notify')).toBe('notify');
    expect(decideRiskAction(RISK_THRESHOLDS.hold + 100, 'challenge')).toBe('challenge');
    expect(decideRiskAction(RISK_THRESHOLDS.hold + 100, 'hold')).toBe('hold');
  });

  it('★ 既定（enforcement 省略）では高スコアでも notify 止まり（既存挙動を変えない・D-38-03）', () => {
    // 全信号が立つ最悪ケース。
    const worst = assessLoginRisk(
      input({
        activeSessions: [],
        recentDistinctIpHashes: 99,
        recentFailedCount: 99,
        userAgent: 'curl/8.4.0',
      }),
    );
    expect(worst.score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.hold);
    expect(worst.level).toBe('high');
    expect(worst.action).toBe('notify');
  });

  it('assessLoginRisk は signals を一貫して返す', () => {
    const result = assessLoginRisk(input({ activeSessions: [] }), 'hold');
    expect(result.signals).toEqual(['new_device', 'new_ip']);
    expect(result.score).toBe(RISK_WEIGHTS.new_device + RISK_WEIGHTS.new_ip);
    expect(result.level).toBe('medium');
    expect(result.action).toBe('notify');
  });
});

describe('Security - login_risk recording (§57 / D-38-07)', () => {
  const userIds: string[] = [];
  let user: FixtureUser;

  beforeEach(async () => {
    user = await makeFixtureUser();
    userIds.push(user.id);
  });

  afterAll(async () => {
    await cleanupFixtureUsers(userIds);
  });

  it('既知デバイス・IP ではイベントを記録しない（allow）', async () => {
    // 既知の (ip_hash, device_name) を持つ有効セッションを先に用意する。
    await persistFixtureSession(
      fixtureSession(user.id, { ipHash: 'iphash-known', deviceName: 'Chrome on Windows' }),
    );
    const assessment = await evaluateAndRecordLoginRisk({
      userId: user.id,
      ipHash: 'iphash-known',
      deviceName: 'Chrome on Windows',
      ip: '203.0.113.10',
      userAgent: CHROME_UA,
      enforcement: 'hold',
    });
    expect(assessment.action).toBe('allow');
    const rows = await getDb()
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it('新規デバイスでは login_risk を記録し、metadata は level / signals / action のみ', async () => {
    const assessment = await evaluateAndRecordLoginRisk({
      userId: user.id,
      ipHash: 'iphash-unknown',
      deviceName: 'Firefox on Linux',
      ip: '203.0.113.99',
      userAgent: CHROME_UA,
      enforcement: 'hold',
    });
    expect(assessment.action).toBe('notify');

    const [row] = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect(row).toBeDefined();
    expect(row!.eventType).toBe('login_risk');
    const metadata = row!.metadata as Record<string, unknown>;
    expect(metadata).toEqual({
      level: 'medium',
      signals: ['new_device', 'new_ip'],
      action: 'notify',
    });
    // 生 UA 全文や PII は metadata に入れない（§45）。
    expect(JSON.stringify(metadata)).not.toContain(CHROME_UA);
    expect(JSON.stringify(metadata)).not.toContain('203.0.113');
  });

  it('自動化 UA は automated_client を signals に含める', async () => {
    await evaluateAndRecordLoginRisk({
      userId: user.id,
      ipHash: 'iphash-unknown',
      deviceName: 'curl',
      ip: '203.0.113.50',
      userAgent: 'curl/8.4.0',
      enforcement: 'hold',
    });
    const [row] = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, user.id));
    expect((row!.metadata as { signals: string[] }).signals).toContain('automated_client');
  });
});
