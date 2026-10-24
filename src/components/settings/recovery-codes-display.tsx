'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { m } from '@/messages/ja';

/**
 * リカバリーコードの 1 回限りの表示（§12.2）。
 *
 * - 「保存しました」にチェックを入れるまで閉じられない（消えると復旧不能のため）。
 * - コピー / ダウンロード / 印刷を用意する。コードは API から再取得できない。
 */
export function RecoveryCodesDisplay({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  const [saved, setSaved] = React.useState(false);

  const asText = codes.join('\n');

  async function copy() {
    await navigator.clipboard?.writeText(asText).catch(() => undefined);
  }

  function download() {
    const blob = new Blob([asText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'recovery-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3">
      <Alert variant="warning" size="sm">
        <AlertDescription>{m('twoFactor.recoveryCodesWarning')}</AlertDescription>
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={copy}>{m('twoFactor.copy')}</Button>
        <Button variant="secondary" size="sm" onClick={download}>{m('twoFactor.download')}</Button>
        <Button variant="secondary" size="sm" onClick={() => window.print()}>{m('twoFactor.print')}</Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        {m('twoFactor.savedConfirm')}
      </label>
      <Button onClick={onClose} disabled={!saved}>{m('twoFactor.close')}</Button>
    </div>
  );
}
