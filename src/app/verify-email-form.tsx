'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type ApiResponse = {
  success: boolean;
  data?: { message?: string };
  error?: { message?: string };
};

export function VerifyEmailForm({ token }: { token: string }) {
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
        else if (active) setError('確認画面を準備できませんでした。再読み込みしてください。');
      })
      .catch(() => {
        if (active) setError('確認画面を準備できませんでした。再読み込みしてください。');
      });
    return () => { active = false; };
  }, []);

  async function confirmEmail() {
    if (!token || !csrfToken) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ token }),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) {
        setError(result.error?.message ?? 'メールアドレスを確認できませんでした。');
        return;
      }
      setMessage('メールアドレスを確認しました。ログインできます。');
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
      {!token && <p className="mb-4 text-sm text-danger" role="alert">確認リンクにトークンがありません。</p>}
      {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}
      {message ? (
        <p className="text-sm text-success" role="status">{message} <Link className="underline" href="/login">ログイン</Link></p>
      ) : (
        <button
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-fg disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={confirmEmail}
          disabled={!token || !csrfToken || submitting}
        >
          {submitting ? '確認中…' : 'メールアドレスを確認する'}
        </button>
      )}
    </section>
  );
}
