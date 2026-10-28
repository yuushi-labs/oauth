import { softDeleteUser, findUserById } from '@/lib/db/queries/users';
import { revokeAllSessions } from '@/lib/auth/session';
import { invalidateAllUserTokens } from '@/lib/db/queries/tokens';
import { revokeUserOidcGrants } from '@/lib/oidc/grants';
import { deleteCredentialsByUser } from '@/lib/db/queries/webauthn';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { sendAccountDeletionEmail } from '@/lib/auth/email/templates';
import { deliverEmailSafely } from '@/lib/auth/email/deliver';

/**
 * アカウント削除の実処理（§24）。パスワード／2FA／Passkey／メール確認のどの確認経路から
 * 呼ばれても同じ副作用になるよう 1 か所に集約する。
 *
 * - 論理削除（`status='deleted'` / `deleted_at`）。物理削除は保持期間（30 日）後の
 *   `purge-expired` が行う（D-36-09）。
 * - 全セッション・全トークン・Passkey・OIDC grant を失効させる。これで削除直後に
 *   同じ資格情報で入り直しても、ログイン経路（`status` 判定）と OIDC 経路の両方で弾かれる。
 * - `account_deleted` を記録し、本人へ削除通知メールを送る（best-effort・BUG-6）。
 */
export async function performAccountDeletion(args: {
  userId: string;
  ip: string;
  userAgent: string;
  /** `security_events.metadata` に載せる補足（確認手段など）。秘密情報は入れない。 */
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { userId, ip, userAgent, metadata = {} } = args;

  await softDeleteUser(userId);
  await revokeAllSessions(userId, 'account_delete');
  await invalidateAllUserTokens(userId);
  await deleteCredentialsByUser(userId);
  const revokedClients = await revokeUserOidcGrants(userId);

  await recordSecurityEvent('account_deleted', userId, ip, userAgent, {
    revokedOidcClients: revokedClients.length,
    ...metadata,
  });

  const fullUser = await findUserById(userId);
  if (fullUser) {
    await deliverEmailSafely({
      kind: 'account_deletion',
      userId,
      ip,
      userAgent,
      send: () => sendAccountDeletionEmail(fullUser.email),
    });
  }
}
