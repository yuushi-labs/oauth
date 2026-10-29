import { describe, expect, it } from 'vitest';
import { evaluateAlerts, type AlertThresholds } from '@/lib/ops/alerting';
import { OPS_THRESHOLDS } from '@/config/ops';

const THRESHOLDS: AlertThresholds = {
  loginFailed: { windowMs: 300_000, threshold: 10 },
  rateLimited: { windowMs: 300_000, threshold: 20 },
  oidcTokenFailed: { windowMs: 300_000, threshold: 20 },
  serverErrors: { windowMs: 300_000, threshold: 10 },
};

describe('Phase 9 - alert evaluation', () => {
  it('emits nothing when all metrics are zero', () => {
    expect(evaluateAlerts({}, THRESHOLDS)).toEqual([]);
  });

  it('emits nothing below the warning ratio', () => {
    // 10 の 80% = 8。8 は「超えていない」ので出さない。
    expect(evaluateAlerts({ loginFailed: 8 }, THRESHOLDS)).toEqual([]);
  });

  it('emits a warning above the warning ratio but at or below the threshold', () => {
    const [decision] = evaluateAlerts({ loginFailed: 9 }, THRESHOLDS);
    expect(decision).toMatchObject({ key: 'loginFailed', severity: 'warning', observed: 9, threshold: 10 });
  });

  it('emits critical when the threshold is exceeded', () => {
    const [decision] = evaluateAlerts({ loginFailed: 11 }, THRESHOLDS);
    expect(decision).toMatchObject({ key: 'loginFailed', severity: 'critical', observed: 11, threshold: 10 });
  });

  it('treats the threshold exactly as not critical', () => {
    const [decision] = evaluateAlerts({ loginFailed: 10 }, THRESHOLDS);
    expect(decision?.severity).toBe('warning');
  });

  it('returns multiple decisions when several keys fire', () => {
    const decisions = evaluateAlerts({ loginFailed: 11, rateLimited: 21 }, THRESHOLDS);
    expect(decisions.map((d) => d.key).sort()).toEqual(['loginFailed', 'rateLimited']);
  });

  it('defaults to the configured thresholds', () => {
    const [decision] = evaluateAlerts({ loginFailed: OPS_THRESHOLDS.loginFailed.threshold + 1 });
    expect(decision?.severity).toBe('critical');
  });
});
