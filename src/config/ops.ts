/**
 * 運用の閾値（Phase 9 / D-39-04）。
 *
 * 監視のアラート判定とバックアップ保持は 1 か所に集約する。`alerting.ts` は
 * ここを既定値として受け取り、マジックナンバーを持たない。
 */
export type AlertThreshold = { windowMs: number; threshold: number };

/** アラート判定の閾値（`observed` が `threshold` を超えたら発火）。 */
export const OPS_THRESHOLDS = {
  loginFailed: { windowMs: 300_000, threshold: 30 },
  rateLimited: { windowMs: 300_000, threshold: 50 },
  oidcTokenFailed: { windowMs: 300_000, threshold: 20 },
  serverErrors: { windowMs: 300_000, threshold: 10 },
} as const satisfies Record<string, AlertThreshold>;

export type AlertKey = keyof typeof OPS_THRESHOLDS;

/** バックアップの保持日数（§53）。これを過ぎた `backup-*.dump.enc` は削除する。 */
export const BACKUP_RETENTION_DAYS = 30;

/** Turnstile のタイムアウト既定（ミリ秒）。 */
export const CAPTCHA_TIMEOUT_MS = 3000;

/** アラートの warning は閾値の 80% 超で出す（`critical` は 100% 超）。 */
export const ALERT_WARNING_RATIO = 0.8;
