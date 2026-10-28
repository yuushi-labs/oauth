/**
 * 不審ログイン検知（§57）の重み・閾値・アクション写像。
 *
 * 判定ロジック（`src/lib/auth/risk.ts`）から数値を切り離し、調整点を 1 か所に集約する（D-38-02）。
 * 外部 geo-IP サービスは使わない。観測できる値（ip_hash / device_name / security_events の集計）
 * だけで判定する（D-38-01）。
 */

import { getEnv } from '@/lib/env';

/** リスク信号の重み。合計がスコアになる。 */
export const RISK_WEIGHTS = {
  new_device: 20,
  new_ip: 10,
  rapid_distinct_ips: 30,
  failed_burst: 30,
  automated_client: 25,
} as const;

/** スコア → アクションの閾値（以上でそのアクション）。 */
export const RISK_THRESHOLDS = {
  notify: 20,
  challenge: 50,
  hold: 80,
} as const;

/** 判定に使う集計ウィンドウ（ミリ秒）。 */
export const RISK_WINDOWS = {
  distinctIp: 3_600_000,
  failedBurst: 900_000,
} as const;

/** 信号を立てる件数の下限。 */
export const RISK_LIMITS = {
  distinctIps: 3,
  failedCount: 5,
} as const;

/** アクションの上限（環境ごとに段階導入できる）。 */
export const RISK_ENFORCEMENT_LEVELS = ['notify', 'challenge', 'hold'] as const;
export type RiskEnforcement = (typeof RISK_ENFORCEMENT_LEVELS)[number];

export function getRiskEnforcement(): RiskEnforcement {
  return getEnv().RISK_ENFORCEMENT;
}
