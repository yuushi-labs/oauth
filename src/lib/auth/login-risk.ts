import { RISK_WINDOWS, getRiskEnforcement, type RiskEnforcement } from '@/config/risk';
import { countDistinctRecentIpHashes, countRecentFailedLogins } from '@/lib/db/queries/security-events';
import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { assessLoginRisk, type RiskAssessment } from '@/lib/auth/risk';

/**
 * DB から観測値を集めて `assessLoginRisk` を呼び、`login_risk` を記録する薄いラッパ。
 * 判定そのものは `risk.ts`（純関数）にあり、ここは I/O だけを担う。
 *
 * metadata には `level` と `signals` だけを入れる（生 IP・UA 全文・PII は入れない・§45 / D-38-07）。
 */
export type EvaluateLoginRiskParams = {
  userId: string;
  /** 今回のセッション ID。有効セッションの判定から除外する。 */
  currentSessionId?: string;
  ipHash: string | null;
  deviceName: string;
  ip: string;
  userAgent: string;
  enforcement?: RiskEnforcement;
};

export async function evaluateAndRecordLoginRisk(params: EvaluateLoginRiskParams): Promise<RiskAssessment> {
  const sessions = await listActiveSessionsByUser(params.userId);
  const activeSessions = sessions
    .filter((session) => session.id !== params.currentSessionId)
    .map((session) => ({ ipHash: session.ipHash, deviceName: session.deviceName }));

  const [recentDistinctIpHashes, recentFailedCount] = await Promise.all([
    countDistinctRecentIpHashes(params.userId, RISK_WINDOWS.distinctIp),
    countRecentFailedLogins(params.userId, RISK_WINDOWS.failedBurst),
  ]);

  const assessment = assessLoginRisk(
    {
      ipHash: params.ipHash,
      deviceName: params.deviceName,
      activeSessions,
      recentDistinctIpHashes,
      recentFailedCount,
      userAgent: params.userAgent,
    },
    params.enforcement ?? getRiskEnforcement(),
  );

  if (assessment.action !== 'allow') {
    await recordSecurityEvent('login_risk', params.userId, params.ip, params.userAgent, {
      level: assessment.level,
      signals: assessment.signals,
      action: assessment.action,
    });
  }

  return assessment;
}
