'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { errorMessage, m } from '@/messages/ja';

/**
 * 連携の確認フォーム（Phase 4-B）。
 *
 * 2 つの操作を提供する:
 * - `signup`   … このメールアドレスでアカウントを作る（email が未使用のときだけ出す）
 * - `password` … パスワードでログインし、**email が一致したときだけ**連携する
 *
 * どちらの操作でも CSRF トークンは `apiClient` が自動で付ける（D-30-22）。
 */
export function SocialConfirmForm({
  providerLabel,
  providerEmail,
  canSignup,
  hasExistingAccount,
}: {
  providerLabel: string;
  providerEmail: string | null;
  /** 「このメールで作る」を出せるか（検証済みかつ未使用） */
  canSignup: boolean;
  /** 既存アカウントと一致しているか（password で連携できる） */
  hasExistingAccount: boolean;
}) {
  const router = useRouter();
  const [identifier, setIdentifier] = React.useState(providerEmail ?? '');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState<'signup' | 'password' | 'cancel' | ''>('');

  async function run(action: 'signup' | 'password') {
    setError('');
    setBusy(action);
    try {
      await apiClient.post('/api/auth/oauth/social-login', {
        action,
        ...(action === 'password' ? { identifier, password } : {}),
      });
      resetCsrfCache();
      // 完了後は新しいセッションになるので、`/` へ戻して再描画する
      router.replace('/');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? messageFor(caught.code) : m('oauth.confirm.error.internal'));
      setBusy('');
    }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      await apiClient.post('/api/auth/oauth/social-login/cancel');
      router.replace('/login');
      router.refresh();
    } catch {
      setError(m('oauth.confirm.error.internal'));
      setBusy('');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <p className="text-xs text-muted-fg">{m('oauth.confirm.emailLabel')}</p>
          <p className="font-medium">{providerEmail ?? '—'}</p>
          {canSignup ? (
            <p className="text-xs text-muted-fg">{m('oauth.confirm.newAccountNotice')}</p>
          ) : (
            <p className="text-xs text-muted-fg">
              {hasExistingAccount
                ? m('oauth.confirm.existingAccountNotice', { provider: providerLabel })
                : m('oauth.confirm.emailUnverifiedNotice')}
            </p>
          )}
        </CardContent>
      </Card>

      {canSignup && (
        <Button onClick={() => void run('signup')} disabled={busy !== ''} aria-busy={busy === 'signup'}>
          {busy === 'signup' ? m('oauth.confirm.submitting') : m('oauth.confirm.signupAction')}
        </Button>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run('password');
        }}
      >
        <p className="text-sm text-muted-fg">
          {m('oauth.confirm.differentAccountNotice', { provider: providerLabel })}
        </p>
        <Label className="flex flex-col gap-1">
          {m('oauth.confirm.identifierLabel')}
          <Input
            autoComplete="username"
            name="identifier"
            onChange={(event) => setIdentifier(event.target.value)}
            required
            type="text"
            value={identifier}
          />
        </Label>
        <Label className="flex flex-col gap-1">
          {m('oauth.confirm.passwordLabel')}
          <Input
            autoComplete="current-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </Label>
        <Button type="submit" disabled={busy !== ''} aria-busy={busy === 'password'}>
          {busy === 'password' ? m('oauth.confirm.submitting') : m('oauth.confirm.passwordAction')}
        </Button>
      </form>

      <Button
        variant="outline"
        onClick={() => void cancel()}
        disabled={busy !== ''}
        aria-busy={busy === 'cancel'}
      >
        {m('oauth.confirm.cancel')}
      </Button>
    </div>
  );
}

/** API のエラーコードをこの画面専用の文言に割り当てる。 */
function messageFor(code: string): string {
  switch (code) {
    case 'INVALID_STATE':
      return m('oauth.confirm.error.invalidState');
    case 'INVALID_CREDENTIALS':
      return m('oauth.confirm.error.invalidCredentials');
    case 'EMAIL_CONFLICT':
      return m('oauth.confirm.error.emailConflict');
    case 'ACCOUNT_LINKED_ELSEWHERE':
      return m('oauth.confirm.error.linkedElsewhere');
    case 'ACCOUNT_ALREADY_LINKED':
      return m('oauth.errors.already_linked');
    case 'ACCOUNT_NOT_LINKABLE':
      return m('oauth.confirm.error.notLinkable');
    case 'RATE_LIMITED':
      return m('oauth.confirm.error.rateLimited');
    case 'ACCOUNT_SUSPENDED':
      return errorMessage('ACCOUNT_SUSPENDED');
    default:
      return m('oauth.confirm.error.internal');
  }
}