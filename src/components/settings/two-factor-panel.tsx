'use client';

import * as React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RecoveryCodesDisplay } from '@/components/settings/recovery-codes-display';
import { StrongReauthDialog } from '@/components/settings/strong-reauth-dialog';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { m } from '@/messages/ja';

type Status = {
  enabled: boolean;
  recovery_codes_remaining: number;
  strong_reauth_methods: string[];
};

type SetupData = { secret: string; otpauth_uri: string; qr_svg: string };

const LOW_THRESHOLD = 3;

/**
 * 2 段階認証カード（§12.1）。
 *
 * 状態（無効 / setup 中 / 有効）ごとに表示と操作を切り替える。無効化・再生成は
 * `StrongReauthDialog`（パスワード ＋ コード）を通す。`strong_reauth_methods` は
 * サーバ（`GET /api/auth/2fa`）から受け取るため、Phase 6 の Passkey 追加でここは変わらない。
 */
export function TwoFactorPanel({ initial }: { initial: Status }) {
  const [status, setStatus] = React.useState<Status>(initial);
  const [setupData, setSetupData] = React.useState<SetupData | null>(null);
  const [code, setCode] = React.useState('');
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [dialog, setDialog] = React.useState<'disable' | 'regenerate' | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function refresh() {
    const next = await apiClient.get<Status>('/api/auth/2fa');
    setStatus(next);
  }

  async function startSetup() {
    setError('');
    setBusy(true);
    try {
      const data = await apiClient.post<SetupData>('/api/auth/2fa/setup');
      setSetupData(data);
      setCode('');
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('common.loading'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await apiClient.post<{ enabled: boolean; recovery_codes: string[] }>(
        '/api/auth/2fa/verify',
        { code },
      );
      setSetupData(null);
      setRecoveryCodes(data.recovery_codes);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('common.loading'));
    } finally {
      setBusy(false);
    }
  }

  async function runDisable(reauthCode: string) {
    await apiClient.post('/api/auth/2fa/disable', { code: reauthCode });
    await refresh();
  }

  async function runRegenerate(reauthCode: string) {
    const data = await apiClient.post<{ recovery_codes: string[] }>(
      '/api/auth/2fa/recovery-codes/regenerate',
      { code: reauthCode },
    );
    setRecoveryCodes(data.recovery_codes);
    await refresh();
  }

  const low = status.enabled && status.recovery_codes_remaining < LOW_THRESHOLD;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          {status.enabled ? (
            <ShieldCheck aria-hidden className="size-4 text-success" />
          ) : (
            <ShieldAlert aria-hidden className="size-4 text-muted-fg" />
          )}
          {m('twoFactor.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {recoveryCodes ? (
          <RecoveryCodesDisplay codes={recoveryCodes} onClose={() => setRecoveryCodes(null)} />
        ) : setupData ? (
          <form className="flex flex-col gap-3" onSubmit={confirmSetup}>
            <p className="text-sm text-muted-fg">{m('twoFactor.setupInstruction')}</p>
            <div
              className="w-fit rounded-md border border-border bg-card p-2"
              // SVG はサーバが生成した文字列（外部入力ではない）。QR の描画のみを許可する。
              dangerouslySetInnerHTML={{ __html: setupData.qr_svg }}
            />
            <p className="break-all text-xs text-muted-fg">
              {m('twoFactor.manualSecret')}: <code className="font-mono">{setupData.secret}</code>
            </p>
            <Label className="flex flex-col gap-1">
              {m('twoFactor.codeLabel')}
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                required
              />
            </Label>
            {error && (
              <Alert variant="danger" size="sm">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || code.length !== 6}>
                {busy ? m('common.loading') : m('twoFactor.verify')}
              </Button>
              <Button variant="secondary" onClick={() => setSetupData(null)} disabled={busy}>
                {m('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">
                {status.enabled ? m('twoFactor.enabled') : m('twoFactor.disabled')}
              </span>
              {status.enabled && (
                <span className="text-xs text-muted-fg">
                  {m('twoFactor.recoveryCodesRemaining', { count: status.recovery_codes_remaining })}
                </span>
              )}
            </div>
            {low && (
              <Alert variant="warning" size="sm">
                <AlertDescription>{m('twoFactor.recoveryCodesLow')}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="danger" size="sm">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              {status.enabled ? (
                <>
                  <Button variant="secondary" onClick={() => setDialog('regenerate')}>
                    {m('twoFactor.regenerate')}
                  </Button>
                  <Button variant="destructive" onClick={() => setDialog('disable')}>
                    {m('twoFactor.disable')}
                  </Button>
                </>
              ) : (
                <Button onClick={startSetup} disabled={busy}>
                  {m('twoFactor.enable')}
                </Button>
              )}
            </div>
          </>
        )}

        <StrongReauthDialog
          open={dialog !== null}
          onOpenChange={(open) => setDialog(open ? dialog : null)}
          methods={status.strong_reauth_methods}
          title={m('twoFactor.strongReauthTitle')}
          description={m('twoFactor.strongReauthInstruction')}
          onConfirmed={(reauthCode) =>
            dialog === 'regenerate' ? runRegenerate(reauthCode) : runDisable(reauthCode)
          }
        />
      </CardContent>
    </Card>
  );
}
