'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PasswordStrength } from '@/components/auth/password-strength';
import { TotpLoginStep } from '@/components/auth/totp-login-step';
import { EmailUnverifiedNotice } from '@/components/auth/email-unverified-notice';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { APP_DESCRIPTION, APP_NAME } from '@/config/app';
import { errorMessage, m } from '@/messages/ja';

type AuthMode = 'login' | 'register';

/**
 * ログイン / 登録フォーム。
 *
 * - CSRF トークンは `api/client` が付与する（D-30-22）。付与できなくてもサーバ側で拒否される
 * - 文言は messages 経由（D-30-18）
 * - autocomplete 属性を用途ごとに指定する（§13.1）
 * - 社会ログイン/passkey/2FA は registry（Phase 4 以降）から自動生成するため、ここでは描画しない（D-30-21）
 */
export function AuthForm({
  mode,
  returnTo,
  oauthError,
  socialSlot,
}: {
  mode: AuthMode;
  returnTo?: string;
  /** OAuth コールバックから `?error=` で渡された利用者向けの文言（§12.2）。 */
  oauthError?: string;
  /**
   * 社会ログインボタンの差し込み口（§12）。
   *
   * **サーバーコンポーネントから `ReactNode` として受け取る**。このファイルを
   * `import` するとクライアントバンドルに巻き込まれ、`process.env` を参照する
   * registry がブラウザ側で 0 件になり、hydration mismatch になる（BUG-11）。
   * そのため `LoginButtons` はここでは import せず、page 側で渡す。
   */
  socialSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(oauthError ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [unverified, setUnverified] = useState<{ email: string; resendAvailable: boolean } | null>(null);
  const isRegister = mode === 'register';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const nextPassword = String(form.get('password') ?? '');

    if (isRegister && nextPassword !== String(form.get('password_confirmation') ?? '')) {
      setError(m('pwStrength.mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const payload = isRegister
        ? { email: form.get('email'), username: form.get('username'), password: nextPassword }
        : { email_or_username: form.get('email_or_username'), password: nextPassword };
      const result = await apiClient.post<{ message: string; twoFactorRequired?: boolean }>(`/api/auth/${mode}`, payload);

      if (isRegister) {
        setError('');
        router.push('/verify-email');
        router.refresh();
        return;
      }
      if (result.twoFactorRequired) {
        // 2FA 有効。同じページ内で TOTP ステップへ切り替える（§12.3）。
        resetCsrfCache();
        setTwoFactorRequired(true);
        return;
      }
      resetCsrfCache();
      router.replace(returnTo?.startsWith('/oauth2/interaction/') ? returnTo : '/');
      router.refresh();
    } catch (caught) {
      // 未確認 email は専用の案内（再送導線つき）を出す（D-33-21）。`data.email` が無ければ通常のエラー。
      if (caught instanceof ApiClientError && caught.code === 'EMAIL_NOT_VERIFIED' && caught.email) {
        setUnverified({ email: caught.email, resendAvailable: caught.resendAvailable });
        return;
      }
      // 失敗はすべて既定メッセージで提示し、列挙攻撃に材料を渡さない（§46）
      setError(caught instanceof ApiClientError ? caught.message : errorMessage('INTERNAL_ERROR'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 text-center">
          <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
          <p className="mt-2 text-sm text-muted-fg">{APP_DESCRIPTION}</p>
        </div>
        <ThemeToggle />
      </header>

      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        {twoFactorRequired ? (
          <TotpLoginStep returnTo={returnTo} onBack={() => setTwoFactorRequired(false)} />
        ) : unverified ? (
          <EmailUnverifiedNotice
            email={unverified.email}
            resendAvailable={unverified.resendAvailable}
            onBack={() => { setUnverified(null); setError(''); }}
          />
        ) : (
        <>
        <h1 className="mb-6 text-xl font-semibold">
          {isRegister ? m('auth.registerTitle') : m('auth.loginTitle')}
        </h1>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {isRegister ? (
            <>
              <Label className="flex flex-col gap-1">
                {m('auth.username')}
                <Input name="username" autoComplete="username" minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" required />
              </Label>
              <Label className="flex flex-col gap-1">
                {m('auth.email')}
                <Input name="email" type="email" autoComplete="email" maxLength={254} required />
              </Label>
            </>
          ) : (
            <Label className="flex flex-col gap-1">
              {m('auth.identifierLabel')}
              <Input name="email_or_username" autoComplete="username" required />
            </Label>
          )}

          <Label className="flex flex-col gap-1">
            {m('auth.passwordLabel')}
            <Input
              name="password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={isRegister ? 8 : undefined}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Label>

          {isRegister && (
            <>
              <PasswordStrength value={password} />
              <Label className="flex flex-col gap-1">
                {m('auth.confirmPasswordLabel')}
                <Input
                  name="password_confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
              </Label>
            </>
          )}

          {error && (
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? m('common.loading') : isRegister ? m('auth.submitRegister') : m('auth.submitLogin')}
          </Button>
        </form>

        {/* 社会ログイン/passkey/2FA は registry から自動生成。0 件なら描画されない（D-30-21）。
            描画内容はサーバーコンポーネントから渡された Node のため、server と client で一致する。*/}
        {!isRegister && socialSlot && <div className="mt-4">{socialSlot}</div>}

        <div className="mt-6 flex flex-col gap-2 text-sm text-muted-fg">
          {!isRegister && (
            <Link className="underline" href="/forgot-password">{m('auth.forgotLink')}</Link>
          )}
          <p>
            {isRegister ? m('auth.hasAccountPrompt') : m('auth.noAccountPrompt')}{' '}
            <Link className="font-medium text-primary underline" href={isRegister ? '/login' : '/register'}>
              {isRegister ? m('auth.submitLogin') : m('auth.submitRegister')}
            </Link>
          </p>
        </div>
        </>
        )}
      </section>
    </main>
  );
}