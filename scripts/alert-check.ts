import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPS_THRESHOLDS } from '@/config/ops';
import { evaluateAlerts, type AlertMetrics } from '@/lib/ops/alerting';
import {
  countRecentEventsByType,
  countRecentFailedEventTypes,
} from '@/lib/db/queries/security-events';
import { getPool } from '@/lib/db/client';
import { logger } from '@/lib/util/logger';
import { describeErrorChain } from '@/lib/util/error-chain';

/**
 * 監視アラートの判定 CLI（Phase 9 / P9-A-05・D-39-05）。
 *
 * `pnpm alert:check`
 * `security_events` を集計し、閾値を超えたものだけを構造化ログ（1 行 JSON）で出す。
 * 外部 SaaS へは送らない（収集側が拾う）。redaction は `logger` が担う。
 */

export async function collectAlertMetrics(): Promise<AlertMetrics> {
  const [loginFailed, rateLimited, oidcTokenFailed, serverErrors] = await Promise.all([
    countRecentEventsByType('login_failed', OPS_THRESHOLDS.loginFailed.windowMs),
    countRecentEventsByType('rate_limited', OPS_THRESHOLDS.rateLimited.windowMs),
    countRecentEventsByType('oidc_token_failed', OPS_THRESHOLDS.oidcTokenFailed.windowMs),
    countRecentFailedEventTypes(OPS_THRESHOLDS.serverErrors.windowMs),
  ]);
  return { loginFailed, rateLimited, oidcTokenFailed, serverErrors };
}

async function main(): Promise<void> {
  const decisions = evaluateAlerts(await collectAlertMetrics());
  if (decisions.length === 0) {
    process.stdout.write('no alerts\n');
    return;
  }
  for (const decision of decisions) {
    const meta = {
      alert: decision.key,
      severity: decision.severity,
      observed: decision.observed,
      threshold: decision.threshold,
    };
    if (decision.severity === 'critical') logger.error('ops alert', meta);
    else logger.warn('ops alert', meta);
  }
  process.stdout.write(`${decisions.length} alert(s)\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  void import('dotenv/config').then(main).catch((error: unknown) => {
    process.stderr.write(`alert check failed: ${describeErrorChain(error)}\n`);
    process.exitCode = 1;
  }).finally(() => getPool().end().catch(() => undefined));
}
