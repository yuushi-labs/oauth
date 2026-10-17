'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { errorMessage, m } from '@/messages/ja';

/** 変更を確定するのは画面内の POST のみ。GET では状態変更しない（§25）。 */
export function EmailChangeForm({ token }: { token: string }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function confirmEmail() {
    setError('');
    if (!token) {
      setError(errorMessage('INVALID_TOKEN'));
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/api/auth/email/change/confirm', { token });
      resetCsrfCache();
      setMessage(m('auth.emailChangeDone'));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : errorMessage('INVALID_TOKEN'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message ? (
        <>
          <Alert variant="success">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
          <Link className="text-sm text-primary underline" href="/login">{m('auth.submitLogin')}</Link>
        </>
      ) : (
        <Button onClick={() => void confirmEmail()} disabled={!token || submitting} aria-busy={submitting}>
          {submitting ? m('common.loading') : m('auth.emailChangeAction')}
        </Button>
      )}
    </div>
  );
}