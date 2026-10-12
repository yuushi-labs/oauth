import { Resend } from 'resend';
import { requireLazyEnv } from '@/lib/env';
import { logger } from '@/lib/util/logger';

export type EmailParams = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendEmail(params: EmailParams): Promise<void> {
  const apiKey = requireLazyEnv('RESEND_API_KEY');
  const from = requireLazyEnv('EMAIL_FROM');
  const resend = new Resend(apiKey);

  try {
    await resend.emails.send({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
  } catch (error) {
    logger.error('Email send failed', {
      to: params.to,
      subject: params.subject,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}