'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { errorMessage, m } from '@/messages/ja';

/**
 * 未確認 email の案内と確認メール再送（§12.4 / D-33-21 / D-33-22）。
 *
 * ログインが 403 `EMAIL_NOT_VERIFIED` を返したときに `AuthForm` のエラー表示の代わりに出す。
 * email は 403 応答の `data.email` を prefill 済み・読み取り専用で使う（打ち直させない）。
 * 再送は `requireAuth: false` の `POST /api/auth/resend-verification` を呼ぶ（この画面で完結）。
 */
export function EmailUnverifiedNotice({
  email,
  resendAvailable,
  onBack,
}: {
  email: string;
  resendAvailable: boolean;
  onBack: () => void;
}) {
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function resend() {
    setMessage('');
    setError('');
    setBusy(true);
    try {
      await apiClient.post('/api/auth/resend-verification', { email });
      setMessage(m('auth.resendSent'));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : errorMessage('INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{m('twoFactor.emailNotVerifiedTitle')}</h2>
      <p className="text-sm text-muted-fg">
        {m('twoFactor.emailNotVerifiedBody', { email })}
      </p>
      <p aria-live="polite" className="text-sm text-muted-fg">{email}</p>
      {message && (
        <Alert variant="success" size="sm">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="danger" size="sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        {resendAvailable && (
          <Button onClick={resend} disabled={busy} aria-busy={busy}>
            {busy ? m('common.loading') : m('twoFactor.emailNotVerifiedResend')}
          </Button>
        )}
        <Button variant="secondary" onClick={onBack}>
          {m('twoFactor.emailNotVerifiedBack')}
        </Button>
      </div>
    </div>
  );
}
