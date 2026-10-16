'use client';

import { useEffect, useState } from 'react';

type Grant = { id: string; name: string; operator: string; scopes: string[]; clientActive: boolean; lastUsedAt: string | null };
type ApiResponse = { success: boolean; error?: { message?: string } };

const scopeNames: Record<string, string> = {
  openid: 'アカウントID', profile: 'プロフィール', email: '確認済みメールアドレス',
};

export function ConnectedApps({ grants }: { grants: Grant[] }) {
  const [csrfToken, setCsrfToken] = useState('');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [items, setItems] = useState(grants);

  useEffect(() => {
    fetch('/api/auth/csrf', { cache: 'no-store' })
      .then(async (response) => (await response.json()) as { success: boolean; data?: { csrfToken?: string } })
      .then((body) => { if (body.success && body.data?.csrfToken) setCsrfToken(body.data.csrfToken); })
      .catch(() => setError('フォームを準備できませんでした。ページを再読み込みしてください。'));
  }, []);

  async function revoke(id: string) {
    setError('');
    setBusyId(id);
    try {
      const response = await fetch('/api/auth/oidc/grants', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ grant_id: id }),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) {
        setError(result.error?.message ?? '連携を取り消せませんでした。');
        return;
      }
      setItems((current) => current.filter((item) => item.id !== id));
    } catch {
      setError('通信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setBusyId('');
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <h1 className="text-xl font-semibold">接続済みサービス</h1>
      <p className="mt-2 text-sm text-muted-fg">許可したサービスと共有範囲を確認し、いつでも連携を取り消せます。</p>
      {error && <p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
      {items.length === 0 ? <p className="mt-6 text-sm">接続済みサービスはありません。</p> : (
        <ul className="mt-6 divide-y divide-border">
          {items.map((grant) => (
            <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between" key={grant.id}>
              <div>
                <h2 className="font-medium">{grant.name}</h2>
                <p className="mt-1 text-xs text-muted-fg">運営者: {grant.operator || grant.name}</p>
                <p className="mt-1 text-sm text-muted-fg">共有範囲: {grant.scopes.map((scope) => scopeNames[scope] ?? scope).join('、')}</p>
                <p className="mt-1 text-xs text-muted-fg">最終利用: {grant.lastUsedAt ? new Date(grant.lastUsedAt).toLocaleString('ja-JP') : '記録なし'}</p>
                {!grant.clientActive && <p className="mt-1 text-xs text-danger">このサービスは提供元によって利用できなくなりました。</p>}
              </div>
              <button className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60" type="button" disabled={!csrfToken || busyId === grant.id} onClick={() => void revoke(grant.id)}>
                {busyId === grant.id ? '処理中…' : '連携を取り消す'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
