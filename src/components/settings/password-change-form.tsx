'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PasswordStrength } from '@/components/auth/password-strength';
import { ReauthDialog } from '@/components/auth/reauth-dialog';
import { useToast } from '@/components/ui/toast';
import { m } from '@/messages/ja';

/**
 * パスワード変更（§8 / §37 の「[変更]」）。
 * 既存の `POST /api/auth/password/change`（再認証必須）を再利用する（D-30-20）。
 * 成功するとサーバが全セッションを破棄するため CSRF キャッシュも破棄する。
 */
export function PasswordChangeForm() {
  const router = useRouter();
  const { push } = useToast();
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const pendingSubmit = React.useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (password !== confirmation) {
      setError(m('pwStrength.mismatch'));
      return;
    }
    setBusy(true);
    try {
      await apiClient.post('/api/auth/password/change', {
        current_password: currentPassword,
        new_password: password,
      });
      resetCsrfCache();
      push({ variant: 'success', title: m('auth.resetDone') });
      setCurrentPassword(''); setPassword(''); setConfirmation('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        pendingSubmit.current = true;
        setReauthOpen(true);
        return;
      }
      setError(caught instanceof ApiClientError ? caught.message : m('auth.resetDone'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{m('settings.password')}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {error && (
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Label className="flex flex-col gap-1">
            {m('reauth.passwordLabel')}
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </Label>
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
            {m('auth.resetTitle')}（{m('pwStrength.label')}）
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
          <div>
            <Button type="submit" disabled={busy || !currentPassword || !password}>
              {busy ? m('common.saving') : m('auth.resetAction')}
            </Button>
          </div>
        </form>
      </CardContent>

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={(open) => {
          setReauthOpen(open);
          if (!open) pendingSubmit.current = false;
        }}
        onReauthenticated={() => {
          // 再認証後に元の操作を 1 度だけ再試行する
          if (pendingSubmit.current) {
            pendingSubmit.current = false;
            setError('');
          }
        }}
      />
    </Card>
  );
}