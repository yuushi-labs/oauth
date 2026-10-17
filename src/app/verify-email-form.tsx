'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { m } from '@/messages/ja';

/**
 * メール確認（§25: GET では状態変更しない）。
 *
 * ページ表示は GET、確定は画面内の POST。auto POST は StrictMode の二重実行と
 * 再レンダによる重複を避けるため useRef で 1 回だけ実行する。
 */
export function VerifyEmailForm({ token }: { token: string }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
  const autoPosted = useRef(false);

  const confirm = useCallback(async () => {
    if (!token) {
      setError('確認リンクにトークンがありません。');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/api/auth/verify-email', { token });
      resetCsrfCache();
      setError('');
      setMessage(m('auth.verifyDone'));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('auth.verifyFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [token]);

  useEffect(() => {
    if (autoPosted.current || !token) return;
    autoPosted.current = true;
    void confirm();
  }, [token, confirm]);

  async function resend() {
    setResendMessage('');
    try {
      await apiClient.post('/api/auth/resend-verification');
      setResendMessage(m('auth.resendSent'));
    } catch (caught) {
      setResendMessage(
        caught instanceof ApiClientError && caught.status === 429
          ? m('auth.resendTooMany')
          : m('auth.resendFailed'),
      );
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
      {error && (
        <Alert variant="danger" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message ? (
        <div className="flex flex-col gap-4">
          <Alert variant="success">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
          <Link className="text-sm text-primary underline" href="/login">{m('auth.submitLogin')}</Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Button onClick={() => void confirm()} disabled={!token || submitting} aria-busy={submitting}>
            {submitting ? m('common.loading') : m('auth.verifyAction')}
          </Button>
          <div className="flex flex-col gap-2">
            <Button variant="secondary" size="sm" onClick={() => void resend()}>
              {m('auth.resendAction')}
            </Button>
            {resendMessage && (
              <p className="text-sm text-muted-fg" role="status">{resendMessage}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}