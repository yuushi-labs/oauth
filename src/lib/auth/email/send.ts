import { Resend } from 'resend';
import { requireLazyEnv } from '@/lib/env';
import { logger } from '@/lib/util/logger';

export type EmailParams = {
  to: string;
  subject: string;
  /**
   * HTML 本文。プレーンテキストのみ送る場合は省略する（`SEND_HTML=false` 時の既定）。
   * Resend 側のバウンス対策で、一旦プレーンテキストのみ送っている（templates.ts 参照）。
   */
  html?: string;
  text: string;
};

export type EmailTransport = {
  send(params: EmailParams): Promise<void>;
};

let transportOverride: EmailTransport | null = null;

/**
 * 差し替え口（BUG-6）。テストでは `src/test/helpers/email.ts` のメモリ実装を注入し、
 * 送信成功/失敗とメール本文（トークン含む）を観測できるようにする。
 * 本番では常に null のまま Resend が使われる。
 */
export function setEmailTransport(next: EmailTransport | null): void {
  transportOverride = next;
}

export function getEmailTransportOverride(): EmailTransport | null {
  return transportOverride;
}

async function sendViaResend(params: EmailParams): Promise<void> {
  const apiKey = requireLazyEnv('RESEND_API_KEY');
  const from = requireLazyEnv('EMAIL_FROM');
  const resend = new Resend(apiKey);

  try {
    await resend.emails.send({
      from,
      to: params.to,
      subject: params.subject,
      // html が無いときは text のみ送る（Resend は html 省略可）。
      ...(params.html ? { html: params.html } : {}),
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

export async function sendEmail(params: EmailParams): Promise<void> {
  if (transportOverride) {
    await transportOverride.send(params);
    return;
  }
  await sendViaResend(params);
}