import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailParams } from '@/lib/auth/email/send';

/**
 * BUG-23: Resend で全メールがバウンスしたため、HTML を一旦やめてプレーンテキストのみ送る。
 * `SEND_HTML_EMAIL=true` で HTML を復旧できる（テンプレートは残置）ことを固定する。
 *
 * `templates.ts` は import 時に `process.env.SEND_HTML_EMAIL` を読むため、env を設定してから
 * `vi.resetModules()` 後に動的 import する。`send.ts` も同じ registry から取り出して
 * transport 差し替えを共有させる（別インスタンスだと差し替えが効かない）。
 */
const originalSendHtmlEmail = process.env.SEND_HTML_EMAIL;

beforeEach(() => {
  // 外部環境の SEND_HTML_EMAIL を引き継がない（1 件目の前に必ず解除する）。
  vi.resetModules();
  delete process.env.SEND_HTML_EMAIL;
});

afterEach(() => {
  vi.resetModules();
  if (originalSendHtmlEmail === undefined) delete process.env.SEND_HTML_EMAIL;
  else process.env.SEND_HTML_EMAIL = originalSendHtmlEmail;
});

async function captureVerification(): Promise<EmailParams[]> {
  const { setEmailTransport } = await import('@/lib/auth/email/send');
  const outbox: EmailParams[] = [];
  setEmailTransport({ async send(params) { outbox.push(params); } });
  const { sendVerificationEmail } = await import('@/lib/auth/email/templates');
  await sendVerificationEmail('user@example.com', 'https://auth.example.com/verify-email?token=abc');
  return outbox;
}

describe('email plain-text default (BUG-23)', () => {
  it('既定では html を送らず text のみ（バウンス対策）', async () => {
    const outbox = await captureVerification();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.html).toBeUndefined();
    expect(outbox[0]!.text).toContain('https://auth.example.com/verify-email?token=abc');
  });

  it('SEND_HTML_EMAIL=true なら html を付けて送る（復旧用の切替）', async () => {
    process.env.SEND_HTML_EMAIL = 'true';
    const outbox = await captureVerification();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.html).toContain('https://auth.example.com/verify-email?token=abc');
  });
});
