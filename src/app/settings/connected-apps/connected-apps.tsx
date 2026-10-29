'use client';

import { useState } from 'react';
import { Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { formatLocalDateTime } from '@/lib/util/datetime';
import { m } from '@/messages/ja';

type Grant = {
  id: string;
  name: string;
  operator: string;
  scopes: string[];
  clientActive: boolean;
  lastUsedAt: string | null;
};

const scopeNames: Record<string, string> = {
  openid: 'アカウントID',
  profile: 'プロフィール',
  email: '確認済みメールアドレス',
};

/**
 * 接続済みサービス（OIDC グラント）の一覧と取り消し。
 *
 * 送信は共有の `apiClient` を使う（CSRF の付与・403 の再試行を一元化。D-30-22）。
 * 日時は `formatLocalDateTime` で整形する。`toLocaleString` は server/client で
 * タイムゾーンが異なり hydration mismatch になるため使わない。
 */
export function ConnectedApps({ grants }: { grants: Grant[] }) {
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [items, setItems] = useState(grants);

  async function revoke(id: string) {
    setError('');
    setBusyId(id);
    try {
      await apiClient.delete('/api/auth/oidc/grants', { grant_id: id });
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : '連携を取り消せませんでした。');
    } finally {
      setBusyId('');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">{m('settings.connectedApps')}</h1>
        <p className="mt-2 text-sm text-muted-fg">
          許可したサービスと共有範囲を確認し、いつでも連携を取り消せます。
        </p>
      </header>

      {error && (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-fg">
            <Plug aria-hidden className="size-5 shrink-0" />
            接続済みサービスはありません。
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((grant) => (
            <li key={grant.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="font-medium text-fg">{grant.name}</h2>
                    <p className="mt-1 text-xs text-muted-fg">
                      運営者: {grant.operator || grant.name}
                    </p>
                    <p className="mt-1 text-sm text-muted-fg">
                      共有範囲: {grant.scopes.map((scope) => scopeNames[scope] ?? scope).join('、')}
                    </p>
                    <p className="mt-1 text-xs text-muted-fg">
                      最終利用:{' '}
                      {grant.lastUsedAt ? formatLocalDateTime(grant.lastUsedAt) : '記録なし'}
                    </p>
                    {!grant.clientActive && (
                      <p className="mt-1 text-xs text-danger">
                        このサービスは提供元によって利用できなくなりました。
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={busyId === grant.id}
                    onClick={() => void revoke(grant.id)}
                  >
                    連携を取り消す
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
