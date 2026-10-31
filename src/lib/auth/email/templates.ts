import { sendEmail } from './send';
import { messages } from '@/messages/ja';

/**
 * HTML メールを送るか。Resend で全メールがバウンスしたため、まずプレーンテキストのみ送る。
 * 復旧したら `true` に戻すだけで HTML 送信を再開できる（テンプレートは `messages.emails` に残置）。
 * `SEND_HTML=true` でも環境変数で上書き可能。
 */
const SEND_HTML = process.env.SEND_HTML_EMAIL === 'true';

/** html を送るかどうかで `html` フィールドを出し分ける（text は常に送る）。 */
function htmlField(html: string): { html?: string } {
  return SEND_HTML ? { html } : {};
}

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.verification.subject,
    ...htmlField(messages.emails.verification.html(url)),
    text: messages.emails.verification.text(url),
  });
}

export async function sendResendVerificationEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.resend.subject,
    ...htmlField(messages.emails.resend.html(url)),
    text: messages.emails.resend.text(url),
  });
}

export async function sendPasswordResetEmail(
  to: string,
  url: string,
  meta: { ip: string; time: string },
): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.passwordReset.subject,
    ...htmlField(messages.emails.passwordReset.html(url, meta)),
    text: messages.emails.passwordReset.text(url, meta),
  });
}

export async function sendSecurityNotificationEmail(
  to: string,
  data: { device: string; ip: string; time: string; region?: string | null },
): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.securityNotification.subject,
    ...htmlField(messages.emails.securityNotification.html(data)),
    text: messages.emails.securityNotification.text(data),
  });
}

export async function sendChangeNotificationEmail(
  to: string,
  data: { change: string; time: string; ip: string },
): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.changeNotification.subject,
    ...htmlField(messages.emails.changeNotification.html(data)),
    text: messages.emails.changeNotification.text(data),
  });
}

export async function sendAccountDeletionEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.accountDeletion.subject,
    ...htmlField(messages.emails.accountDeletion.html()),
    text: messages.emails.accountDeletion.text(),
  });
}

/**
 * セルフサービス退会のメール確認リンク（§24）。
 *
 * 削除を確定する前にこのリンクを開かせる。リンクのトークンは 1 回限り消費され（D-16）、
 * 確定した時点で論理削除が走る。心当たりがない場合の案内（無視すれば削除されない）を必ず載せる。
 */
export async function sendAccountDeletionConfirmEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.accountDeletionConfirm.subject,
    ...htmlField(messages.emails.accountDeletionConfirm.html(url)),
    text: messages.emails.accountDeletionConfirm.text(url),
  });
}
