'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch } from 'lucide-react';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ReauthDialog } from '@/components/auth/reauth-dialog';
import { formatLocalDateTime } from '@/lib/util/datetime';
import { m } from '@/messages/ja';

export type LinkedAccountRow = {
  id: string;
  provider: string;
  provider_label: string;
  provider_email: string | null;
  created_at: string;
  last_used_at: string;
};

export type AvailableProvider = { id: string; label: string };

/**
 * 連携アカウント管理（§11 / P4-C-03）。
 *
 * - 追加は `POST /api/auth/oauth/link` → 返ってきた authorize URL へ **location で遷移**する。
 *   provider 側への遷移なので router.push ではなく window.location.assign を使う。
 * - 解除は `DELETE /api/auth/accounts/{id}`。owner 確認はサーバ側で行う（§49）。
 * - どちらも**再認証が要る**ので、REAUTH_REQUIRED を受けたら ReauthDialog を開き、
 *   完了後に同じ操作を 1 回だけ再試行する（無限ループは作らない）。
 */
export function ConnectedAccountsPanel({
  initialAccounts,
  availableProviders,
  timezone,
}: {
  initialAccounts: LinkedAccountRow[];
  availableProviders: AvailableProvider[];
  timezone: string;
}) {
  const router = useRouter();
  const [items, setItems] = React.useState(initialAccounts);
  const [error, setError] = React.useState('');
  const [pendingId, setPendingId] = React.useState('');
  const [confirmId, setConfirmId] = React.useState('');
  const [linkBusy, setLinkBusy] = React.useState('');
  const [reauthOpen, setReauthOpen] = React.useState(false);
  /** 再認証後に 1 回だけ再生する処理。null なら再試行しない。 */
  const retryRef = React.useRef<(() => void) | null>(null);

  const linkedProviders = new Set(items.map((item) => item.provider));
  const addable = availableProviders.filter((provider) => !linkedProviders.has(provider.id));

  async function reload(): Promise<void> {
    const result = await apiClient.get<{ accounts: LinkedAccountRow[] }>('/api/auth/accounts');
    setItems(result.accounts);
  }

  /** 1 段だけ再認証を求めるラッパ。2 回目以降は素通しで投げる。 */
  async function withReauth<T>(run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'REAUTH_REQUIRED' && retryRef.current === null) {
        retryRef.current = () => {
          void run().catch((next: unknown) => {
            setError(next instanceof ApiClientError ? next.message : m('common.retry'));
          });
        };
        setReauthOpen(true);
        return undefined;
      }
      throw caught;
    }
  }

  async function link(provider: AvailableProvider): Promise<void> {
    setError('');
    setLinkBusy(provider.id);
    try {
      const result = await withReauth(() =>
        apiClient.post<{ authorizeUrl: string }>('/api/auth/oauth/link', { provider: provider.id }),
      );
      if (!result) return;
      window.location.assign(result.authorizeUrl);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('common.retry'));
      setLinkBusy('');
    }
  }

  async function unlink(row: LinkedAccountRow): Promise<void> {
    setError('');
    setPendingId(row.id);
    try {
      const done = await withReauth(() =>
        apiClient.delete<{ message: string }>(`/api/auth/accounts/${row.id}`),
      );
      setConfirmId('');
      if (!done) return;
      await reload();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('common.retry'));
    } finally {
      setPendingId('');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-fg">{m('oauth.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((row) => (
            <li key={row.id}>
              <Card>
                <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <span className="flex items-center gap-2 font-medium">
                      <GitBranch aria-hidden className="size-4 text-muted-fg" />
                      {row.provider_label}
                    </span>
                    {row.provider_email && (
                      <span className="text-xs text-muted-fg">
                        {m('oauth.providerEmail', { email: row.provider_email })}
                      </span>
                    )}
                    <time className="text-xs text-muted-fg" dateTime={row.created_at}>
                      {m('oauth.linkedAt', { date: formatLocalDateTime(row.created_at, timezone) })}
                    </time>
                    <time className="text-xs text-muted-fg" dateTime={row.last_used_at}>
                      {m('oauth.lastUsedAt', { date: formatLocalDateTime(row.last_used_at, timezone) })}
                    </time>
                  </div>
                  <Button variant="outline" onClick={() => setConfirmId(row.id)} disabled={pendingId === row.id}>
                    {m('oauth.unlinkAction')}
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <p className="text-xs text-muted-fg">{m('oauth.count', { count: items.length })}</p>
        {addable.length > 0 && <p className="text-xs text-muted-fg">{m('oauth.emptyHint')}</p>}
        {availableProviders.length === 0 && (
          <p className="text-xs text-muted-fg">{m('oauth.availableNone')}</p>
        )}
        <ul className="flex flex-col gap-2">
          {addable.map((provider) => (
            <li key={provider.id}>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => void link(provider)}
                disabled={linkBusy !== ''}
                aria-busy={linkBusy === provider.id}
              >
                <GitBranch aria-hidden className="size-4" />
                {linkBusy === provider.id
                  ? m('common.loading')
                  : m('oauth.providerLabel', { provider: provider.label })}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={confirmId !== ''} onOpenChange={(open) => !open && setConfirmId('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m('oauth.unlinkConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {m('oauth.unlinkConfirmBody', {
                provider: items.find((row) => row.id === confirmId)?.provider_label ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmId('')}>
              {m('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const row = items.find((item) => item.id === confirmId);
                if (row) void unlink(row);
              }}
            >
              {m('oauth.unlinkAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={(open) => {
          setReauthOpen(open);
          if (!open) retryRef.current = null;
        }}
        onReauthenticated={() => {
          const pending = retryRef.current;
          retryRef.current = null;
          setReauthOpen(false);
          pending?.();
        }}
      />
    </div>
  );
}