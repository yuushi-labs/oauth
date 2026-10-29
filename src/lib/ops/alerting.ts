import {
  ALERT_WARNING_RATIO,
  OPS_THRESHOLDS,
  type AlertKey,
  type AlertThreshold,
} from '@/config/ops';

/**
 * 監視アラートの判定（Phase 9 / D-39-04・D-39-05）。
 *
 * 純関数。集計値を受け取り、閾値を超えたキーだけを返す。外部へは送らず、
 * `alert-check.ts` が `logger` へ 1 行 JSON で出す（redaction が自動で効く）。
 */

export type AlertMetrics = Partial<Record<AlertKey, number>>;

export type AlertSeverity = 'warning' | 'critical';

export type AlertDecision = {
  key: AlertKey;
  severity: AlertSeverity;
  observed: number;
  threshold: number;
};

export type AlertThresholds = Record<AlertKey, AlertThreshold>;

/**
 * `observed > threshold` で `critical`、`observed > threshold * 0.8` で `warning`。
 * 0 件は出さない。複数キーが同時に該当したら全件返す。
 */
export function evaluateAlerts(
  metrics: AlertMetrics,
  thresholds: AlertThresholds = OPS_THRESHOLDS,
): AlertDecision[] {
  const decisions: AlertDecision[] = [];
  for (const key of Object.keys(thresholds) as AlertKey[]) {
    const observed = metrics[key] ?? 0;
    if (observed <= 0) continue;
    const { threshold } = thresholds[key];
    if (observed > threshold) {
      decisions.push({ key, severity: 'critical', observed, threshold });
    } else if (observed > threshold * ALERT_WARNING_RATIO) {
      decisions.push({ key, severity: 'warning', observed, threshold });
    }
  }
  return decisions;
}
