'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { APP_DESCRIPTION, APP_NAME } from '@/config/app';

type AuthMode = 'login' | 'register';
type ApiResponse = {
  success: boolean;
  data?: { csrfToken?: string };
  error?: { message?: string };
};

export function AuthForm({ mode, returnTo }: { mode: AuthMode; returnTo?: string }) {
  const router = useRouter();
  const [csrfToken, setCsrfToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isRegister = mode === 'register';

  useEffect(() => {
    let active = true;
    fetch('/api/auth/csrf', { cache: 'no-store' })
      .then(async (response) => (await response.json()) as ApiResponse)
      .then((result) => {
        if (active && result.success && result.data?.csrfToken) setCsrfToken(result.data.csrfToken);
        else if (active) setError('フォームを準備できませんでした。ページを再読み込みしてください。');
      })
      .catch(() => {
        if (active) setError('フォームを準備できませんでした。ページを再読み込みしてください。');
      });
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

    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (isRegister && password !== String(form.get('password_confirmation') ?? '')) {
      setError('パスワードが一致しません。');
      return;
    }

    const payload = isRegister
      ? { email: form.get('email'), username: form.get('username'), password }
      : { email_or_username: form.get('email_or_username'), password };
    setSubmitting(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) {
        setError(result.error?.message ?? '処理に失敗しました。入力内容を確認してください。');
        return;
      }
      if (isRegister) {
        setMessage('確認メールを送信しました。メールに記載されたリンクから登録を完了してください。');
      } else {
        router.replace(returnTo?.startsWith('/oauth2/interaction/') ? returnTo : '/');
        router.refresh();
      }
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <header className="mb-8 text-center">
        <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
        <p className="mt-2 text-sm text-muted-fg">{APP_DESCRIPTION}</p>
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold">{isRegister ? 'アカウント登録' : 'ログイン'}</h1>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {isRegister ? (
            <>
              <label className="flex flex-col gap-1 text-sm font-medium">
                ユーザー名
                <input className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal" name="username" autoComplete="username" minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" required />
                <span className="text-xs font-normal text-muted-fg">3〜32文字。英数字、ハイフン、アンダースコアが使えます。</span>
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                メールアドレス
                <input className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal" name="email" type="email" autoComplete="email" maxLength={254} required />
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-1 text-sm font-medium">
              メールアドレスまたはユーザー名
              <input className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal" name="email_or_username" autoComplete="username" required />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium">
            パスワード
            <input className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal" name="password" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} minLength={isRegister ? 8 : undefined} maxLength={128} required />
            {isRegister && <span className="text-xs font-normal text-muted-fg">8〜128文字で入力してください。</span>}
          </label>
          {isRegister && (
            <label className="flex flex-col gap-1 text-sm font-medium">
              パスワード（確認）
              <input className="rounded-md border border-border-strong bg-bg px-3 py-2 font-normal" name="password_confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
            </label>
          )}
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {message && <p className="text-sm text-success" role="status">{message}</p>}
          <button className="rounded-md bg-primary px-4 py-2 font-medium text-primary-fg disabled:cursor-not-allowed disabled:opacity-60" type="submit" disabled={!csrfToken || submitting}>
            {submitting ? '送信中…' : isRegister ? '登録する' : 'ログイン'}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-muted-fg">
          {isRegister ? 'すでにアカウントをお持ちですか？ ' : 'アカウントをお持ちでないですか？ '}
          <Link className="font-medium text-primary underline" href={isRegister ? '/login' : '/register'}>
            {isRegister ? 'ログイン' : '新規登録'}
          </Link>
        </p>
      </section>
    </main>
  );
}
