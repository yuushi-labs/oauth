import { sendEmail } from './send';
import { messages } from '@/messages/ja';

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.verification.subject,
    html: messages.emails.verification.html(url),
    text: messages.emails.verification.text(url),
  });
}

export async function sendResendVerificationEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.resend.subject,
    html: messages.emails.resend.html(url),
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
    html: messages.emails.passwordReset.html(url, meta),
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
    html: messages.emails.securityNotification.html(data),
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
    html: messages.emails.changeNotification.html(data),
    text: messages.emails.changeNotification.text(data),
  });
}

export async function sendAccountDeletionEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: messages.emails.accountDeletion.subject,
    html: messages.emails.accountDeletion.html(),
    text: messages.emails.accountDeletion.text(),
  });
}