import {
  RISK_LIMITS,
  RISK_THRESHOLDS,
  RISK_WEIGHTS,
  getRiskEnforcement,
  type RiskEnforcement,
} from '@/config/risk';

/**
 * 不審ログイン検知（§57）。判定は**純関数**で、DB にも HTTP にも触れない。
 *
 * 仕様 §57 は「将来的にリスクベース認証を追加できるようにする（構造）」を求める。
 * ここでは観測値を入力として受け取り、スコア → 3 段階アクション（通知 / 追加認証 / セッション保留）
 * へ写像するところまでを固定する。実際の強制は `RISK_ENFORCEMENT` で段階的に有効化する（D-38-03）。
 *
 * 「短時間で複数地域」は外部 geo-IP を持ち込まず、短期間の複数 `ip_hash` で代理する（D-38-01）。
 */
export type RiskSignal =
  | 'new_device'
  | 'new_ip'
  | 'rapid_distinct_ips'
  | 'failed_burst'
  | 'automated_client';

export type RiskLevel = 'low' | 'medium' | 'high';
export type RiskAction = 'allow' | 'notify' | 'challenge' | 'hold';

/** 自動化クライアントとみなす UA パターン（大文字小文字を無視して部分一致）。 */
const AUTOMATED_UA_PATTERNS = [
  'curl',
  'wget',
  'python-requests',
  'python-urllib',
  'go-http-client',
  'okhttp',
  'java/',
  'axios',
  'node-fetch',
  'headlesschrome',
  'phantomjs',
  'bot',
  'spider',
  'crawler',
];

export type ActiveSessionSnapshot = {
  ipHash: string | null;
  deviceName: string | null;
};

export type LoginRiskInput = {
  /** 今回のログイン元 IP のハッシュ（`hashIp` の結果）。 */
  ipHash: string | null;
  /** 今回のデバイス名（`deriveDeviceName` の結果）。 */
  deviceName: string;
  /** 同一ユーザーの有効セッション（今回の新規セッションは含めない）。 */
  activeSessions: ActiveSessionSnapshot[];
  /** 直近ウィンドウ内で観測された異なる `ip_hash` の数。 */
  recentDistinctIpHashes: number;
  /** 直近ウィンドウ内の `login_failed` 件数。 */
  recentFailedCount: number;
  userAgent: string;
};

export type RiskAssessment = {
  score: number;
  level: RiskLevel;
  action: RiskAction;
  signals: RiskSignal[];
};

export function isAutomatedClient(userAgent: string): boolean {
  const ua = userAgent.trim().toLowerCase();
  if (ua.length === 0) return true;
  return AUTOMATED_UA_PATTERNS.some((pattern) => ua.includes(pattern));
}

/** 信号の重みを合計する。同じ信号が複数回渡されても 1 回だけ数える。 */
export function scoreRisk(signals: RiskSignal[]): number {
  const unique = new Set(signals);
  let total = 0;
  for (const signal of unique) {
    total += RISK_WEIGHTS[signal];
  }
  return total;
}

export function riskLevel(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.challenge) return 'high';
  if (score >= RISK_THRESHOLDS.notify) return 'medium';
  return 'low';
}

/**
 * スコアをアクションへ写像する。`enforcement` はアクションの**上限**として働く。
 * 既定は `'notify'` なので、どれだけ高スコアでも通知止まりになる（D-38-03）。
 */
export function decideRiskAction(score: number, enforcement: RiskEnforcement = getRiskEnforcement()): RiskAction {
  let action: RiskAction = 'allow';
  if (score >= RISK_THRESHOLDS.hold) action = 'hold';
  else if (score >= RISK_THRESHOLDS.challenge) action = 'challenge';
  else if (score >= RISK_THRESHOLDS.notify) action = 'notify';

  const cap: Record<RiskEnforcement, RiskAction> = {
    notify: 'notify',
    challenge: 'challenge',
    hold: 'hold',
  };
  const rank: Record<RiskAction, number> = { allow: 0, notify: 1, challenge: 2, hold: 3 };
  return rank[action] > rank[cap[enforcement]] ? cap[enforcement] : action;
}

/** 入力から信号を判定する。 */
export function detectSignals(input: LoginRiskInput): RiskSignal[] {
  const signals: RiskSignal[] = [];

  const knownDevice =
    Boolean(input.ipHash) &&
    input.activeSessions.some(
      (session) => session.ipHash === input.ipHash && (session.deviceName ?? '') === input.deviceName,
    );
  if (!knownDevice) signals.push('new_device');

  const knownIp = Boolean(input.ipHash) && input.activeSessions.some((session) => session.ipHash === input.ipHash);
  if (!knownIp) signals.push('new_ip');

  if (input.recentDistinctIpHashes >= RISK_LIMITS.distinctIps) signals.push('rapid_distinct_ips');
  if (input.recentFailedCount >= RISK_LIMITS.failedCount) signals.push('failed_burst');
  if (isAutomatedClient(input.userAgent)) signals.push('automated_client');

  return signals;
}

/** 信号判定 → スコア → レベル → アクションをまとめて返す。 */
export function assessLoginRisk(
  input: LoginRiskInput,
  enforcement: RiskEnforcement = getRiskEnforcement(),
): RiskAssessment {
  const signals = detectSignals(input);
  const score = scoreRisk(signals);
  return {
    score,
    level: riskLevel(score),
    action: decideRiskAction(score, enforcement),
    signals,
  };
}
