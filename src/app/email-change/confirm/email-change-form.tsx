'use client';

import { useEffect, useState } from 'react';

type ApiResponse = {
  success: boolean;
  error?: { message?: string };
};

/** 変更を確定するのは画面内の POST のみ。GET では状態変更しない（§25）。 */
export function EmailChangeForm({ token }: { token: string }) {
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

  async function confirmEmail() {
    setError('');
    setMessage('');
    if (!token) {
      setError('確認リンクにトークンがありません。');
      return;
    }
    if (!csrfToken) {
      setError('フォームを準備しています。少し待ってから再度お試しください。');
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/email/change/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ token }),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) {
        setError(result.error?.message ?? 'メールアドレスを変更できませんでした。');
        return;
      }
      setMessage('メールアドレスを変更しました。新しいアドレスでログインできます。');
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!token && <p className="text-sm text-danger" role="alert">確認リンクにトークンがありません。</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {message ? (
        <p className="text-sm text-success" role="status">
          {message} <a className="underline" href="/login">ログイン</a>
        </p>
      ) : (
        <button
          className="rounded-md bg-primary px-4 py-2 font-medium text-primary-fg disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={confirmEmail}
          disabled={!token || !csrfToken || submitting}
        >
          {submitting ? '確認中…' : 'メールアドレス変更を確定する'}
        </button>
      )}
    </div>
  );
}