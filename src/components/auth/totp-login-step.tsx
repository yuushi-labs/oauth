'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { m } from '@/messages/ja';

/**
 * `/login` の 2 段階認証ステップ（§12.3）。
 *
 * ログイン API が `twoFactorRequired: true` を返したときに `AuthForm` から描画される。
 * 「リカバリーコードを使う」で同じ入力欄を切り替える（`inputMode` を `text` に）。
 * 成功したら昇格（`totp_pending = false`）してトップへ遷移する。
 */
export function TotpLoginStep({
  returnTo,
  onBack,
}: {
  returnTo?: string;
  onBack: () => void;
}) {
  const [useRecovery, setUseRecovery] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await apiClient.post('/api/auth/2fa/challenge/verify', { code });
      resetCsrfCache();
      const target = returnTo?.startsWith('/oauth2/interaction/') ? returnTo : '/';
      window.location.assign(target);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('twoFactor.challengeInstruction'));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function backToLogin() {
    try {
      await apiClient.post('/api/auth/logout', {});
    } catch {
      // 保留セッションの破棄に失敗しても画面は戻す
    }
    resetCsrfCache();
    onBack();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{m('twoFactor.challengeTitle')}</h2>
        <p className="mt-1 text-sm text-muted-fg">{m('twoFactor.challengeInstruction')}</p>
      </div>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Label className="flex flex-col gap-1">
          {useRecovery ? m('twoFactor.recoveryCodesTitle') : m('twoFactor.codeLabel')}
          <Input
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            maxLength={useRecovery ? 64 : 6}
            value={code}
            onChange={(event) =>
              setCode(useRecovery ? event.target.value : event.target.value.replace(/\D/g, ''))
            }
            className={useRecovery ? undefined : 'tracking-[0.3em]'}
            required
          />
        </Label>
        {error && (
          <Alert variant="danger" size="sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy || code.length === 0} aria-busy={busy}>
          {busy ? m('common.loading') : m('twoFactor.verify')}
        </Button>
      </form>
      <div className="flex flex-col gap-2 text-sm text-muted-fg">
        <button type="button" className="self-start underline" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>
          {useRecovery ? m('twoFactor.useTotpCode') : m('twoFactor.useRecoveryCode')}
        </button>
        <button type="button" className="self-start underline" onClick={backToLogin}>
          {m('twoFactor.challengeBack')}
        </button>
      </div>
    </div>
  );
}
