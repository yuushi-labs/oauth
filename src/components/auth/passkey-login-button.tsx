'use client';

import * as React from 'react';
import { Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { m } from '@/messages/ja';

/**
 * 「パスキーでログイン」ボタン（§12.2）。
 *
 * `login/options` → `startAuthentication` → `login/verify` の順に呼び、成功したら `returnTo`
 * （既定はトップ）へ遷移する。失敗しても**列挙に資する情報は出さない**（一律の文言）。
 */
export function PasskeyLoginButton({ returnTo }: { returnTo?: string }) {
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [supported, setSupported] = React.useState(true);

  React.useEffect(() => {
    // `navigator.credentials` が無い端末ではボタンを出さない（SSR との食い違いを避けるため effect で判定）。
    setSupported(typeof window !== 'undefined' && window.PublicKeyCredential !== undefined);
  }, []);

  if (!supported) return null;

  async function login() {
    setError('');
    setBusy(true);
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const { options, challenge_id } = await apiClient.post<{
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
        challenge_id: string;
      }>('/api/auth/passkey/login/options');
      const response = await startAuthentication({ optionsJSON: options });
      await apiClient.post('/api/auth/passkey/login/verify', { response, challenge_id });
      resetCsrfCache();
      window.location.href = returnTo && returnTo.startsWith('/') ? returnTo : '/';
    } catch (caught) {
      // 列挙対策: 原因を区別せず一律の文言にする。
      setError(caught instanceof ApiClientError ? caught.message : m('passkey.loginFailed'));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" onClick={login} disabled={busy} aria-busy={busy}>
        <Fingerprint aria-hidden className="size-4" />
        {busy ? m('common.loading') : m('passkey.loginButton')}
      </Button>
      {error && (
        <Alert variant="danger" size="sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
