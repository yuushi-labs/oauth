'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type ApiResponse = {
  success: boolean;
  error?: { code?: string; message?: string };
};

/**
 * トークンは画面に表示しない（§45）。無効・期限切れも既定の文言のみを出し、
 * 原因を区別しない。
 */
export function ResetPasswordForm({ token }: { token: string }) {
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
    if (!token) {
      setError('リンクが無効か、有効期限が切れています。');
      return;
    }
    if (!csrfToken) {
      setError('フォームを準備しています。少し待ってから再度お試しください。');
      return;
    }
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('password_confirmation') ?? '')) {
      setError('パスワードが一致しません。');
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ token, password, password_confirm: password }),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) {
        setError(result.error?.message ?? 'パスワードを変更できませんでした。');
        return;
      }
      // サーバ側で全セッションを破棄するため、CSRF トークンも作り直す
      setCsrfToken('');
      setMessage('パスワードを変更しました。新しいパスワードでログインしてください。');
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  if (message) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-success" role="status">{message}</p>
        <a className="rounded-md bg-primary px-4 py-2 text-center font-medium text-primary-fg" href="/login">ログインする</a>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      {!token && (
        <p className="text-sm text-danger" role="alert">確認リンクにトークンがありません。</p>
      )}
      <label className="flex flex-col gap-1 text-sm font-medium">
        新しいパスワード
        <input
          className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
        <span className="text-xs font-normal text-muted-fg">8〜128文字で入力してください。他のサービスと使い回さないでください。</span>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        新しいパスワード（確認）
        <input
          className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal"
          name="password_confirmation"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
      </label>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <button
        className="rounded-md bg-primary px-4 py-2 font-medium text-primary-fg disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={!token || !csrfToken || submitting}
      >
        {submitting ? '送信中…' : 'パスワードを変更する'}
      </button>
    </form>
  );
}