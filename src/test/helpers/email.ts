import { setEmailTransport, type EmailParams } from '@/lib/auth/email/send';

export type CapturedEmail = EmailParams & { /** 本文から取り出した token（存在しない場合は undefined） */ tokenFromUrl?: string };

/**
 * Resend をメモリ実装に差し替える（BUG-6 の送信 seam）。
 * - 実 HTTP テストから「送信されたメール本文と URL」を観測できるようにする
 * - `failNext()` で 1 回だけ送信失敗を再現でき、best-effort 挙動を検証できる
 */
export function useMemoryEmail(): {
  outbox: CapturedEmail[];
  failNext: (error?: Error) => void;
  restore: () => void;
} {
  const outbox: CapturedEmail[] = [];
  let failure: Error | null = null;

  setEmailTransport({
    async send(params) {
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      const match = /[?&]token=([^&"'\s<]+)/.exec(`${params.html} ${params.text}`);
      outbox.push({ ...params, tokenFromUrl: match?.[1] ? decodeURIComponent(match[1]) : undefined });
    },
  });

  return {
    outbox,
    failNext: (error = new Error('resend unavailable')) => { failure = error; },
    restore: () => setEmailTransport(null),
  };
}

/** テスト終了時に必ず呼んで process -global な差し替えを解除する。 */
export function restoreResendEmail(): void {
  setEmailTransport(null);
}