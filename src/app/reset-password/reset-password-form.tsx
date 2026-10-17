'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PasswordStrength } from '@/components/auth/password-strength';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { errorMessage, m } from '@/messages/ja';

/**
 * トークンは画面に表示しない（§45）。無効・期限切れも既定の文言のみを出し、原因を区別しない。
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!token) {
      setError(errorMessage('INVALID_TOKEN'));
      return;
    }
    if (password !== confirmation) {
      setError(m('pwStrength.mismatch'));
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/api/auth/password/reset', {
        token,
        password,
        password_confirm: password,
      });
      // サーバ側で全セッションを破棄するため CSRF キャッシュも作り直す
      resetCsrfCache();
      setMessage(m('auth.resetDone'));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : errorMessage('INVALID_TOKEN'));
    } finally {
      setSubmitting(false);
    }
  }

  if (message) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        <a
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-fg"
          href="/login"
        >
          {m('auth.submitLogin')}
        </a>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Label className="flex flex-col gap-1">
        {m('auth.resetTitle')}
        <Input
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </Label>
      <PasswordStrength value={password} />
      <Label className="flex flex-col gap-1">
        {m('auth.confirmPassword')}
        <Input
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />
      </Label>
      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={!token || submitting} aria-busy={submitting}>
        {submitting ? m('common.loading') : m('auth.resetAction')}
      </Button>
    </form>
  );
}