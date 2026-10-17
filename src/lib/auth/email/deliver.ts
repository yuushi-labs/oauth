import { recordSecurityEvent } from '@/lib/auth/security-events';
import { logger } from '@/lib/util/logger';

export type EmailKind =
  | 'register_verification'
  | 'resend_verification'
  | 'password_reset'
  | 'email_change'
  | 'security_notification'
  | 'change_notification'
  | 'account_deletion';

export type DeliverEmailOptions = {
  /** 通知の種類。security_events.metadata.kind に入る（生値は入れない） */
  kind: EmailKind;
  /** どの利用者の宛先か（未ログイン経路は null） */
  userId: string | null;
  ip: string;
  userAgent: string;
  /** 実際の送信。失敗を投げずにこの関数で握り、呼び出し元の応答を成功時と同一に保つ */
  send: () => Promise<void>;
};

/**
 * メール送信は best-effort（BUG-6 / 仕様書 §18・§45・§46）。
 *
 * - 送信に失敗しても **呼び出し元の応答は成功時と同一に保つ**。
 *   失敗時の別メッセージや別ステータスを返すと「この email は新規登録された」と
 *   判明し、アカウント存在の列挙攻撃（§46）を許してしまうため。
 * - 失敗は `security_notification_failed` イベントとして検知可能にする。
 * - メール本文・URL（token を含む）はログに一切出さない（§45）。
 *
 * @returns 送信に成功した場合 true
 */
export async function deliverEmailSafely(options: DeliverEmailOptions): Promise<boolean> {
  try {
    await options.send();
    return true;
  } catch (error) {
    await recordSecurityEvent(
      'security_notification_failed',
      options.userId,
      options.ip,
      options.userAgent,
      { kind: options.kind },
    ).catch(() => undefined);
    logger.error('email delivery failed', {
      kind: options.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}