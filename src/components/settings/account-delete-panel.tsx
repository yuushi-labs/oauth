'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiClient, ApiClientError, resetCsrfCache } from '@/lib/api/client';
import { m } from '@/messages/ja';

type Method = 'twofactor' | 'passkey' | 'email';

/**
 * アカウント削除カード（§24）。
 *
 * 確認手段は 2FA（パスワード＋現在のコード）・Passkey・メール確認のいずれか 1 つ（§8）。
 * - 2FA / Passkey は `DELETE /api/auth/account` を強い再認証付きで叩き、その場で削除する。
 * - メール確認は `POST /api/auth/account/delete/request` で確認リンクを送り、
 *   メール内リンク（`/account/delete/confirm`）で確定する。ここでは削除しない。
 * 2FA 無効・Passkey 未登録なら該当タブを出さず、残る手段だけを示す。
 */
export function AccountDeletePanel({
  email,
  twoFactorEnabled,
  methods,
}: {
  email: string;
  twoFactorEnabled: boolean;
  /** `GET /api/auth/2fa` の `strong_reauth_methods`（'password' / 'passkey'）。 */
  methods: string[];
}) {
  const router = useRouter();
  const supportsTwoFactor = twoFactorEnabled;
  const supportsPasskey = methods.includes('passkey');

  const availableMethods: Method[] = [
    ...(supportsTwoFactor ? (['twofactor'] as const) : []),
    ...(supportsPasskey ? (['passkey'] as const) : []),
    'email',
  ];

  const [open, setOpen] = React.useState(false);
  const [method, setMethod] = React.useState<Method>(availableMethods[0]!);
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [emailSent, setEmailSent] = React.useState(false);
  const [deleted, setDeleted] = React.useState(false);

  function resetDialog() {
    setPassword('');
    setCode('');
    setError('');
    setBusy(false);
    setEmailSent(false);
  }

  /** 削除成功後はセッションが失効するため、CSRF キャッシュを捨ててログイン画面へ送る。 */
  function finishDeletion() {
    resetCsrfCache();
    setDeleted(true);
    setOpen(false);
  }

  async function deleteWithCode(submittedCode: string): Promise<void> {
    await apiClient.delete('/api/auth/account', { code: submittedCode });
    finishDeletion();
  }

  async function submitTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await deleteWithCode(code);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        // パスワード再認証（5 分猶予）が未了。通してからコードを再送する。
        try {
          await apiClient.post('/api/auth/reauth', { password });
          await deleteWithCode(code);
          return;
        } catch (retry) {
          setError(retry instanceof ApiClientError ? retry.message : m('accountDelete.failed'));
          return;
        }
      }
      if (caught instanceof ApiClientError && caught.code === 'INVALID_CODE') {
        setCode('');
      }
      setError(caught instanceof ApiClientError ? caught.message : m('accountDelete.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function submitPasskey() {
    setError('');
    setBusy(true);
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const { options, challenge_id } = await apiClient.post<{
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
        challenge_id: string;
      }>('/api/auth/reauth/passkey/options');
      const passkey = await startAuthentication({ optionsJSON: options });
      await apiClient.delete('/api/auth/account', { passkey, challenge_id });
      finishDeletion();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('passkey.loginFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function requestEmail() {
    setError('');
    setBusy(true);
    try {
      await apiClient.post('/api/auth/account/delete/request');
      setEmailSent(true);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('accountDelete.emailFailed'));
    } finally {
      setBusy(false);
    }
  }

  const tabs = [
    ...(supportsTwoFactor
      ? [{ value: 'twofactor', label: m('accountDelete.methodTwoFactor') }]
      : []),
    ...(supportsPasskey ? [{ value: 'passkey', label: m('accountDelete.methodPasskey') }] : []),
    { value: 'email', label: m('accountDelete.methodEmail') },
  ];

  function renderTwoFactor() {
    return (
      <form onSubmit={submitTwoFactor} className="flex flex-col gap-4">
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
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
            {m('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={code.length < 6 || !password}
            loading={busy}
          >
            {m('accountDelete.confirm')}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  function renderPasskey() {
    return (
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="danger" size="sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
            {m('common.cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={submitPasskey} loading={busy}>
            {m('passkey.reauthTabPasskey')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  function renderEmail() {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-fg">{m('accountDelete.emailIntro')}</p>
        {emailSent && (
          <Alert variant="success" size="sm">
            <AlertDescription>{m('accountDelete.emailSent')}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="danger" size="sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
            {m('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={requestEmail}
            disabled={emailSent}
            loading={busy}
          >
            {m('accountDelete.emailSend')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (deleted) {
    return (
      <Card className="border-danger">
        <CardContent className="pt-6">
          <Alert variant="success">
            <AlertDescription>{m('accountDelete.done')}</AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button onClick={() => router.push('/login')}>{m('accountDelete.backToLogin')}</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-danger">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-danger">
          <TriangleAlert aria-hidden className="size-4" />
          {m('accountDelete.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <p className="text-sm text-muted-fg">{m('accountDelete.description')}</p>
        <Alert variant="warning" size="sm">
          <AlertDescription>{m('accountDelete.warningBody')}</AlertDescription>
        </Alert>
        <div>
          <Button variant="destructive" onClick={() => setOpen(true)}>
            {m('accountDelete.open')}
          </Button>
        </div>

        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) resetDialog();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{m('accountDelete.confirmTitle')}</DialogTitle>
              <DialogDescription>{m('accountDelete.methodIntro')}</DialogDescription>
            </DialogHeader>

            {tabs.length > 1 ? (
              <Tabs
                value={method}
                onValueChange={(value) => {
                  setMethod(value as Method);
                  setError('');
                  setEmailSent(false);
                }}
              >
                <TabsList>
                  {tabs.map((entry) => (
                    <TabsTrigger key={entry.value} value={entry.value}>
                      {entry.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="twofactor">
                  {supportsTwoFactor && renderTwoFactor()}
                </TabsContent>
                <TabsContent value="passkey">{supportsPasskey && renderPasskey()}</TabsContent>
                <TabsContent value="email">{renderEmail()}</TabsContent>
              </Tabs>
            ) : (
              renderEmail()
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
