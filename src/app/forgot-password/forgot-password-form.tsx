'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { errorMessage, m } from '@/messages/ja';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';

/**
 * メール送信の成否にかかわらず同一のメッセージを表示する（§46 列挙攻撃対策）。
 * API 側も同じ方針で、失敗時も成功時と同じ文面を返す（BUG-6）。
 */
export function ForgotPasswordForm({
  captchaSiteKey,
  captchaNonce,
}: {
  captchaSiteKey?: string;
  captchaNonce?: string;
} = {}) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [captchaNeeded, setCaptchaNeeded] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    setSubmitting(true);
    try {
      await apiClient.post('/api/auth/password/forgot', {
        email,
        ...(captchaToken ? { captchaToken } : {}),
      });
      setMessage(m('auth.forgotSent'));
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'CAPTCHA_REQUIRED') {
        setCaptchaNeeded(true);
        setCaptchaToken(null);
        return;
      }
      if (caught instanceof ApiClientError && caught.status === 429) {
        setError(errorMessage('RATE_LIMITED'));
        return;
      }
      // 検証エラー以外は失敗の案内のみを出す（登録の有無を悟らせない）
      setError(caught instanceof ApiClientError ? caught.message : errorMessage('INTERNAL_ERROR'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Label className="flex flex-col gap-1">
        {m('auth.email')}
        <Input name="email" type="email" autoComplete="email" maxLength={254} required />
      </Label>
      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {captchaNeeded && captchaSiteKey && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-fg">{m('auth.captchaHint')}</p>
          <TurnstileWidget
            siteKey={captchaSiteKey}
            nonce={captchaNonce}
            action="forgot_password"
            onToken={(token) => {
              setCaptchaToken(token);
              if (token) setError('');
            }}
          />
        </div>
      )}
      {message ? (
        <Alert variant="success">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : (
        <Button type="submit" loading={submitting}>
          {m('auth.forgotAction')}
        </Button>
      )}
    </form>
  );
}
