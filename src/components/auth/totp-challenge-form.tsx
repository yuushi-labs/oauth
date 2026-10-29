'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError } from '@/lib/api/client';

const DIGITS_ONLY = /^\d{0,6}$/;

/**
 * 2 段階認証の入力 UI（§13 の 2FA 入力 UI）。
 *
 * Phase 3 では**器のみ**用意する。実際の検証 API（`/api/auth/2fa/*`）は Phase 5 で
 * 実装されるため、`verify` が渡されない限り送信しない（空のボタンを持たせない）。
 * 入力要件は 6 桁・数字のみ・`autoComplete="one-time-code"`（§13.1）。
 */
export function TotpChallengeForm({
  onVerified,
  verifyEndpoint,
}: {
  onVerified?: (code: string) => void | Promise<void>;
  /** Phase 5 で `/api/auth/2fa/verify` を渡す */
  verifyEndpoint?: string;
}) {
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (code.length !== 6) {
      setError('6 桁の認証コードを入力してください。');
      return;
    }
    setBusy(true);
    try {
      if (verifyEndpoint) {
        await apiClient.post(verifyEndpoint, { code });
      }
      await onVerified?.(code);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : '認証コードを確認できませんでした。',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Label className="flex flex-col gap-1">
        認証コード（6 桁）
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(event) => {
            const next = event.target.value.replace(DIGITS_ONLY, '');
            setCode(next);
          }}
          className="tracking-[0.3em]"
          required
        />
      </Label>
      {error && (
        <Alert variant="danger" size="sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {verifyEndpoint || onVerified ? (
        <Button type="submit" disabled={code.length !== 6} loading={busy}>
          認証する
        </Button>
      ) : (
        <p className="text-xs text-muted-fg">2 段階認証は準備中です。</p>
      )}
    </form>
  );
}
