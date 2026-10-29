'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ReauthDialog } from '@/components/auth/reauth-dialog';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { m } from '@/messages/ja';

/**
 * メールアドレス変更（§14）。
 *
 * `POST /api/auth/email/change`（再認証必須）へ新アドレスを送ると、確認リンクが
 * 新アドレスへ届く。確定はそのリンク先の画面で行う（`/api/auth/email/change/confirm`）。
 * `REAUTH_REQUIRED` は `ReauthDialog` を開き、本人確認後に 1 度だけ再試行する。
 */
export function EmailChangePanel({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = React.useState('');
  const [error, setError] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  /** 再認証後に 1 回だけ再生する送信処理。null なら再試行しない。 */
  const retryRef = React.useRef<(() => void) | null>(null);

  async function runChange(target: string): Promise<void> {
    await apiClient.post('/api/auth/email/change', { new_email: target });
    setSent(true);
    setEmail('');
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSent(false);
    const target = email.trim();
    if (!target) {
      setError(m('emailChange.required'));
      return;
    }
    if (target.toLowerCase() === currentEmail.toLowerCase()) {
      setError(m('emailChange.sameAsCurrent'));
      return;
    }
    setBusy(true);
    try {
      await runChange(target);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        retryRef.current = () => {
          void runChange(target).catch((next: unknown) => {
            setError(next instanceof ApiClientError ? next.message : m('emailChange.failed'));
          });
        };
        setReauthOpen(true);
        return;
      }
      setError(caught instanceof ApiClientError ? caught.message : m('emailChange.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <p className="text-sm text-muted-fg">
        {m('emailChange.current')}: <span className="text-fg">{currentEmail}</span>
      </p>
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <Label className="flex flex-col gap-1">
          {m('emailChange.newLabel')}
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={m('emailChange.placeholder')}
            maxLength={254}
            required
          />
        </Label>
        <p className="text-xs text-muted-fg">{m('emailChange.hint')}</p>
        {sent && (
          <Alert variant="success" size="sm">
            <AlertDescription>{m('emailChange.sent')}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="danger" size="sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" disabled={!email.trim()} loading={busy}>
            {m('emailChange.submit')}
          </Button>
        </div>
      </form>

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        description={m('emailChange.reauthHint')}
        onReauthenticated={() => {
          // ReauthDialog は成功時に onOpenChange(false) を先に呼ぶため、
          // ここで初めて retry を取り出す（onOpenChange 側で消すと再試行が失われる）。
          const retry = retryRef.current;
          retryRef.current = null;
          retry?.();
        }}
      />
    </div>
  );
}
