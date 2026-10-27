'use client';

import * as React from 'react';
import { Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StrongReauthDialog } from '@/components/settings/strong-reauth-dialog';
import { ReauthDialog } from '@/components/auth/reauth-dialog';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { formatLocalDateTime } from '@/lib/util/datetime';
import { m } from '@/messages/ja';

export type PasskeyRow = {
  id: string;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
  backed_up: boolean;
};

type RegistrationOptions = {
  options: Parameters<typeof import('@simplewebauthn/browser').startRegistration>[0]['optionsJSON'];
  challenge_id: string;
};

/**
 * Passkey カード（§12.1）。
 *
 * 登録は `startRegistration`（`@simplewebauthn/browser`）で Ceremony を行い、
 * options 発行 → 署名 → verify の順に API を叩く。削除は `StrongReauthDialog` を通す（D-34-08）。
 * 残り 1 件・パスワード無し・2FA 無効なら削除ボタンを無効化して理由を出す（サーバでも 409）。
 */
export function PasskeyPanel({
  initial,
  methods,
  timezone,
  passwordSet,
  twoFactorEnabled,
}: {
  initial: PasskeyRow[];
  methods: string[];
  timezone: string;
  passwordSet: boolean;
  twoFactorEnabled: boolean;
}) {
  const [rows, setRows] = React.useState<PasskeyRow[]>(initial);
  const [deviceName, setDeviceName] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<PasskeyRow | null>(null);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  /** 再認証後に 1 回だけ再生する登録処理。null なら再試行しない。 */
  const retryRef = React.useRef<(() => void) | null>(null);

  const lastMethod = !passwordSet && rows.length <= 1 && !twoFactorEnabled;

  async function refresh() {
    const data = await apiClient.get<{ passkeys: PasskeyRow[] }>('/api/auth/passkey');
    setRows(data.passkeys);
  }

  /**
   * 登録 Ceremony を実行する。options 発行は再認証必須（D-34-08）なので、
   * `REAUTH_REQUIRED` を受けたら `ReauthDialog` を開いて再試行する。
   */
  async function runRegistration(): Promise<void> {
    const { startRegistration } = await import('@simplewebauthn/browser');
    const { options, challenge_id } = await apiClient.post<RegistrationOptions>(
      '/api/auth/passkey/register/options',
      { device_name: deviceName || undefined },
    );
    const response = await startRegistration({ optionsJSON: options });
    await apiClient.post('/api/auth/passkey/register/verify', {
      response,
      challenge_id,
      device_name: deviceName || undefined,
    });
    setDeviceName('');
    await refresh();
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await runRegistration();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED') {
        retryRef.current = () => {
          void runRegistration().catch((next: unknown) => {
            setError(next instanceof ApiClientError ? next.message : m('passkey.registerFailed'));
          });
        };
        setReauthOpen(true);
        return;
      }
      setError(caught instanceof ApiClientError ? caught.message : m('passkey.registerFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(body: { code?: string; passkey?: unknown; challenge_id?: string }) {
    if (!removing) return;
    await apiClient.delete(`/api/auth/passkey/${removing.id}`, body);
    await refresh();
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Fingerprint aria-hidden className="size-4 text-muted-fg" />
          {m('passkey.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-fg">{m('passkey.none')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-fg">
                    {row.device_name ?? m('passkey.title')}
                    {row.backed_up && (
                      <span className="ml-2 rounded-full bg-hover px-2 py-0.5 text-xs text-muted-fg">
                        {m('passkey.synced')}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-fg">
                    {m('passkey.createdAt')}: {formatLocalDateTime(row.created_at, timezone)} ・{' '}
                    {m('passkey.lastUsedAt')}:{' '}
                    {row.last_used_at ? formatLocalDateTime(row.last_used_at, timezone) : m('passkey.neverUsed')}
                  </span>
                </div>
                <Button
                  variant="destructive"
                  onClick={() => setRemoving(row)}
                  disabled={busy || lastMethod}
                  title={lastMethod ? m('passkey.lastMethod') : undefined}
                >
                  {m('passkey.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {lastMethod && (
          <Alert variant="warning" size="sm">
            <AlertDescription>{m('passkey.lastMethod')}</AlertDescription>
          </Alert>
        )}

        <form className="flex flex-col gap-2" onSubmit={register}>
          <Label className="flex flex-col gap-1">
            {m('passkey.deviceNameLabel')}
            <Input
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder={m('passkey.deviceNamePlaceholder')}
              maxLength={120}
            />
          </Label>
          <p className="text-xs text-muted-fg">{m('passkey.addHint')}</p>
          {error && (
            <Alert variant="danger" size="sm">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? m('common.loading') : m('passkey.add')}
            </Button>
          </div>
        </form>

        <StrongReauthDialog
          open={removing !== null}
          onOpenChange={(open) => setRemoving(open ? removing : null)}
          methods={methods}
          title={m('passkey.removeConfirm')}
          description={m('passkey.title')}
          onConfirmed={(code) => remove({ code })}
          passkeySubmit={(passkey, challengeId) => remove({ passkey, challenge_id: challengeId })}
        />

        <ReauthDialog
          open={reauthOpen}
          onOpenChange={setReauthOpen}
          description={m('passkey.registerReauthHint')}
          onReauthenticated={() => {
            // ReauthDialog は成功時に onOpenChange(false) を先に呼ぶため、
            // ここで初めて retry を取り出す（onOpenChange 側で消すと再試行が失われる）。
            const retry = retryRef.current;
            retryRef.current = null;
            retry?.();
          }}
        />
      </CardContent>
    </Card>
  );
}
