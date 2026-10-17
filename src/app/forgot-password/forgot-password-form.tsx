'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type ApiResponse = {
  success: boolean;
  error?: { message?: string };
};

/**
 * メール送信の成否にかかわらず同一のメッセージを表示する（§46 列挙攻撃対策）。
 * API 側も同じ方針で、失敗時も成功時と同じ文面を返す。
 */
const ALWAYS_SENT = '登録メールアドレスなら再設定メールを送信しました。';

export function ForgotPasswordForm() {
  const [csrfToken, setCsrfToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/csrf', { cache: 'no-store' })
      .then(async (response) => (await response.json()) as { success: boolean; data?: { csrfToken?: string } })
      .then((result) => {
        if (active && result.success && result.data?.csrfToken) setCsrfToken(result.data.csrfToken);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!csrfToken) {
      setError('フォームを準備しています。少し待ってから再度お試しください。');
      return;
    }
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/password/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ email }),
      });
      const result = (await response.json()) as ApiResponse;
      if (response.status === 429) {
        setError('リクエストが多すぎます。しばらくしてから再度お試しください。');
        return;
      }
      if (!response.ok || !result.success) {
        setError(result.error?.message ?? '送信できませんでした。時間をおいて再度お試しください。');
        return;
      }
      setMessage(ALWAYS_SENT);
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <label className="flex flex-col gap-1 text-sm font-medium">
        メールアドレス
        <input
          className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
        />
      </label>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {message && <p className="text-sm text-success" role="status">{message}</p>}
      <button
        className="rounded-md bg-primary px-4 py-2 font-medium text-primary-fg disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={!csrfToken || submitting}
      >
        {submitting ? '送信中…' : '再設定メールを送信'}
      </button>
    </form>
  );
}