'use client';

import * as React from 'react';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { m } from '@/messages/ja';

/**
 * 強い再認証ダイアログ（§9.3 / D-33-23 / D-33-24）。
 *
 * 無効化・再生成では「パスワード（再認証）」と「現在のコード」の 2 要素を要求する。
 * - `REAUTH_REQUIRED`（401）→ 既存の `POST /api/auth/reauth` でパスワードを通し、コードを保持したまま再送する。
 * - `INVALID_CODE`（400）→ コード欄をクリアして再入力させる。
 * Phase 6 は `methods` に `'passkey'` が加わり、Passkey タブを足す（API ルートは無変更）。
 */
export function StrongReauthDialog({
  open,
  onOpenChange,
  methods,
  title,
  description,
  onConfirmed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `GET /api/auth/2fa` の `strong_reauth_methods`（Phase 5 は ['password']）。 */
  methods: string[];
  title: string;
  description: string;
  /** 強い再認証に成功したあとの本体処理。ここで対象 API を呼ぶ。 */
  onConfirmed: (code: string) => Promise<void>;
}) {
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const supportsPassword = methods.includes('password');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {supportsPassword && (
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
          )}
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
            <Button type="submit" disabled={busy || code.length < 6 || (supportsPassword && !password)}>
              {busy ? m('common.loading') : m('twoFactor.strongReauthSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
