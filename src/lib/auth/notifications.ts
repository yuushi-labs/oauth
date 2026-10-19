import { recordSecurityEvent } from '@/lib/auth/security-events';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';
import { sendChangeNotificationEmail, sendSecurityNotificationEmail } from '@/lib/auth/email/templates';
import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';
import { m } from '@/messages/ja';
import type { Session } from '@/lib/db/schema';

/**
 * 新規デバイスからのログイン通知（§18 / D-30-13）。
 *
 * 判定は「**同一ユーザーの他の有効セッションのうちに、同じ ip_hash と device_name の組が無い**」ときだけ
 * 通知する。家庭内 IP の切替だけで連打されないよう 2 要素で判定する。
 */
export async function isFirstSessionFromDevice(
  userId: string,
  newSessionId: string,
  newIpHash: string | null,
  newDeviceName: string,
): Promise<boolean> {
  const rows = await listActiveSessionsByUser(userId);
  const others = rows.filter((row: Session) => row.id !== newSessionId);
  return !others.some(
    (row) => Boolean(newIpHash) && row.ipHash === newIpHash && (row.deviceName ?? '') === newDeviceName,
  );
}

export type NewDeviceLoginParams = {
  userId: string;
  userEmail: string;
  deviceName: string;
  ipMasked: string | null;
  ipCountry: string | null;
  occurredAt: Date;
  ip: string;
  userAgent: string;
};

/**
 * 通知本文にはデバイス名・masked IP・日時・（あれば）地域だけを含める。
 * パスワード・token・TOTP・passkey は**絶対に入れない**（§18・§45）。
 * 送信失敗は握り、ログイン自体は失敗にしない（D-30-27）。
 */
export async function notifyNewDeviceLogin(params: NewDeviceLoginParams): Promise<boolean> {
  const delivered = await deliverEmailSafely({
    kind: 'security_notification',
    userId: params.userId,
    ip: params.ip,
    userAgent: params.userAgent,
    send: () =>
      sendSecurityNotificationEmail(params.userEmail, {
        device: params.deviceName,
        ip: params.ipMasked ?? '不明',
        region: params.ipCountry,
        time: params.occurredAt.toISOString(),
      }),
  });

  if (delivered) {
    await recordSecurityEvent('new_device_login', params.userId, params.ip, params.userAgent, {
      device: params.deviceName,
      notified: true,
    });
  }
  return delivered;
}

export type AccountChangeAction = 'link' | 'unlink';

export type AccountChangeParams = {
  userId: string;
  userEmail: string;
  action: AccountChangeAction;
  provider: string;
  ip: string;
  userAgent: string;
};

/**
 * 連携の追加・解除の通知（§11 / §45）。
 *
 * 本文には「どのプロバイダーを追加/解除したか」「日時」「masked IP」だけを含める。
 * 認可コード・state・トークン・外部 ID は**絶対に入れない**（§45）。
 * 送信失敗は握り、連携操作自体は失敗にしない（D-30-27 と同じ方針）。
 */
export async function notifyAccountChange(params: AccountChangeParams): Promise<boolean> {
  const providerLabel = OAUTH_PROVIDER_REGISTRY.find((p) => p.id === params.provider)?.label ?? params.provider;
  const change =
    params.action === 'link'
      ? m('oauth.result.linked')
      : m('oauth.result.unlinked');

  return deliverEmailSafely({
    kind: 'change_notification',
    userId: params.userId,
    ip: params.ip,
    userAgent: params.userAgent,
    send: () =>
      sendChangeNotificationEmail(params.userEmail, {
        change: `${change}（${providerLabel}）`,
        time: new Date().toISOString(),
        ip: params.ip,
      }),
  });
}