'use client';

import * as React from 'react';
import { apiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { m } from '@/messages/ja';

/**
 * 再認証ダイアログ（§8 / D-14）。
 *
 * 重要な操作（パスワード変更・全ログアウト等）でサーバーが `REAUTH_REQUIRED` を返した時に開き、
 * パスワード入力 → `POST /api/auth/reauth` → 呼び出し側の retry を実行する。
 * reauth_verified_at の猶予は 5 分。
 */
export function ReauthDialog({
  open,
  onOpenChange,
  onReauthenticated,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReauthenticated: () => void | Promise<void>;
  description?: string;
}) {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await apiClient.post('/api/auth/reauth', { password });
      setPassword('');
      onOpenChange(false);
      await onReauthenticated();
    } catch {
      setError(m('reauth.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m('reauth.title')}</DialogTitle>
          <DialogDescription>{description ?? m('reauth.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Label className="flex flex-col gap-1">
            {m('reauth.passwordLabel')}
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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
            <Button type="submit" disabled={!password} loading={busy}>
              {m('reauth.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
