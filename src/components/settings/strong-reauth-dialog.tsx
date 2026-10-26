'use client';

import * as React from 'react';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { m } from '@/messages/ja';

type PasskeySubmit = (passkey: unknown, challengeId: string) => Promise<void>;

/**
 * 強い再認証ダイアログ（§9.3 / D-33-23 / D-33-24 / D-34-11）。
 *
 * 2 つの手段を提供する。
 * - **パスワードタブ**: パスワード（`POST /api/auth/reauth` の 5 分猶予）＋現在のコード。
 *   `REAUTH_REQUIRED`（401）ならパスワードを通してからコードを再送し、`INVALID_CODE`（400）なら
 *   コード欄をクリアする。
 * - **Passkey タブ**: `strong_reauth_methods` に `'passkey'` が含まれるときだけ出す。
 *   `reauth/passkey/options` → `startAuthentication` → 本体 API へ `{ passkey, challenge_id }` を送る。
 */
export function StrongReauthDialog({
  open,
  onOpenChange,
  methods,
  title,
  description,
  onConfirmed,
  passkeySubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `GET /api/auth/2fa` の `strong_reauth_methods`（Phase 5 は ['password']）。 */
  methods: string[];
  title: string;
  description: string;
  /** パスワード＋コードでの本体処理。ここで対象 API を呼ぶ。 */
  onConfirmed: (code: string) => Promise<void>;
  /** Passkey での本体処理。未指定なら Passkey タブを出さない。 */
  passkeySubmit?: PasskeySubmit;
}) {
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const supportsPassword = methods.includes('password');
  const supportsPasskey = methods.includes('passkey') && passkeySubmit !== undefined;
  const [tab, setTab] = React.useState(supportsPassword ? 'password' : 'passkey');

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onConfirmed(code);
      setPassword('');
      setCode('');
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        // パスワード再認証が未了。ここで通し、コードは保持したまま再送する。
        try {
          await apiClient.post('/api/auth/reauth', { password });
          await onConfirmed(code);
          setPassword('');
          setCode('');
          onOpenChange(false);
          return;
        } catch (retry) {
          setError(retry instanceof ApiClientError ? retry.message : m('reauth.failed'));
          return;
        }
      }
      if (caught instanceof ApiClientError && caught.code === 'INVALID_CODE') {
        setCode('');
      }
      setError(caught instanceof ApiClientError ? caught.message : m('reauth.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function submitPasskey() {
    if (!passkeySubmit) return;
    setError('');
    setBusy(true);
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const { options, challenge_id } = await apiClient.post<{
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
        challenge_id: string;
      }>('/api/auth/reauth/passkey/options');
      const passkey = await startAuthentication({ optionsJSON: options });
      await passkeySubmit(passkey, challenge_id);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('passkey.loginFailed'));
    } finally {
      setBusy(false);
    }
  }

  function renderPasswordForm() {
    return (
      <form onSubmit={submitPassword} className="flex flex-col gap-4">
        <Label className="flex flex-col gap-1">
          {m('twoFactor.strongReauthPassword')}
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Label>
        <Label className="flex flex-col gap-1">
          {m('twoFactor.strongReauthCode')}
          <Input
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </Label>
        {error && (
          <Alert variant="danger" size="sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {m('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || code.length < 6 || !password}>
            {busy ? m('common.loading') : m('twoFactor.strongReauthSubmit')}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  function renderPasskeyForm() {
    return (
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="danger" size="sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {m('common.cancel')}
          </Button>
          <Button type="button" onClick={submitPasskey} disabled={busy}>
            {busy ? m('common.loading') : m('passkey.reauthTabPasskey')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const tabs = [
    ...(supportsPassword ? [{ value: 'password', label: m('twoFactor.strongReauthPassword') }] : []),
    ...(supportsPasskey ? [{ value: 'passkey', label: m('passkey.reauthTabPasskey') }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {tabs.length > 1 ? (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {tabs.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="password">{supportsPassword && renderPasswordForm()}</TabsContent>
            <TabsContent value="passkey">{supportsPasskey && renderPasskeyForm()}</TabsContent>
          </Tabs>
        ) : supportsPassword ? (
          renderPasswordForm()
        ) : (
          renderPasskeyForm()
        )}
      </DialogContent>
    </Dialog>
  );
}
