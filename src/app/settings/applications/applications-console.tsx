'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export type ApplicationSummary = {
  clientId: string;
  name: string;
  operator: string;
  clientType: string;
  redirectUris: string[];
  allowedScopes: string[];
  webOrigins: string[];
  active: boolean;
  createdAt: string;
  ownerUsername: string | null;
  grantCount: number;
  lastUsedAt: string | null;
  isOwner: boolean;
};

type ApiResponse<T> = { success: boolean; data?: T; error?: { message?: string } };

const scopeNames: Record<string, string> = {
  openid: 'アカウントID',
  profile: 'プロフィール',
  email: '確認済みメールアドレス',
};

export function useCsrfToken(): string {
  const [csrfToken, setCsrfToken] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/auth/csrf', { cache: 'no-store' })
      .then(async (response) => (await response.json()) as ApiResponse<{ csrfToken: string }>)
      .then((body) => {
        if (active && body.success && body.data?.csrfToken) setCsrfToken(body.data.csrfToken);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return csrfToken;
}

export async function postJson<T>(
  path: string,
  body: unknown,
  csrfToken: string,
  method = 'POST',
): Promise<{ ok: boolean; data?: T; message: string }> {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as ApiResponse<T>;
    return {
      ok: response.ok && result.success,
      data: result.data,
      message: result.error?.message ?? '処理に失敗しました。',
    };
  } catch {
    return { ok: false, message: '通信に失敗しました。時間をおいて再度お試しください。' };
  }
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? `${label}コピー済み` : `${label}をコピー`}
    </Button>
  );
}

function listToLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ApplicationCreateForm({
  csrfToken,
  onCreated,
}: {
  csrfToken: string;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [operator, setOperator] = useState('');
  const [clientType, setClientType] = useState<'public' | 'confidential'>('confidential');
  const [redirectUris, setRedirectUris] = useState('');
  const [webOrigins, setWebOrigins] = useState('');
  const [scopes, setScopes] = useState<string[]>(['openid', 'profile', 'email']);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const result = await postJson<{ clientId: string; clientSecret: string | null }>(
      '/api/auth/oidc/clients',
      {
        name,
        operator,
        clientType,
        redirectUris: listToLines(redirectUris),
        webOrigins: listToLines(webOrigins),
        scopes,
      },
      csrfToken,
    );
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.message);
      return;
    }
    setCreatedId(result.data.clientId);
    setSecret(result.data.clientSecret);
    setName('');
    setOperator('');
    setRedirectUris('');
    setWebOrigins('');
    onCreated();
    router.refresh();
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">新しいアプリを作成</h2>
      <p className="mt-2 text-sm text-muted-fg">
        自作サービス向けの OIDC / OAuth 2.0 クライアントを登録します。client secret
        は作成時に一度だけ表示されます。
      </p>
      <form className="mt-4 grid gap-4" onSubmit={submit}>
        <label className="grid gap-1 text-sm">
          <span>アプリ名</span>
          <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>運営者名（同意画面に表示されます）</span>
          <Input
            required
            maxLength={100}
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>種別（作成後は変更できません）</span>
          <select
            className="h-10 rounded-md border border-border-strong bg-bg px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            value={clientType}
            onChange={(e) => setClientType(e.target.value as 'public' | 'confidential')}
          >
            <option value="confidential">
              confidential（サーバーサイド。client secret を使用）
            </option>
            <option value="public">public（ブラウザ・ネイティブ。secret なし）</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>リダイレクト URI（1行に 1 つ。https 必須。loopback のみ http 可）</span>
          <Textarea
            rows={3}
            required
            value={redirectUris}
            onChange={(e) => setRedirectUris(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Web origin（public のみ。1行に 1 つ）</span>
          <Textarea rows={2} value={webOrigins} onChange={(e) => setWebOrigins(e.target.value)} />
        </label>
        <fieldset className="grid gap-1 text-sm">
          <legend>許可する scope</legend>
          {Object.entries(scopeNames).map(([scope, label]) => (
            <label key={scope} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                disabled={scope === 'openid'}
                onChange={(e) =>
                  setScopes((current) =>
                    e.target.checked
                      ? [...current, scope]
                      : current.filter((item) => item !== scope),
                  )
                }
              />
              <span>
                {label}（{scope}）
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button className="justify-self-start" type="submit" loading={busy} disabled={!csrfToken}>
          アプリを作成する
        </Button>
      </form>
      {createdId && (
        <div className="mt-4 rounded-md border border-border p-4 text-sm">
          <p>アプリを作成しました。</p>
          <p className="mt-2 flex items-center gap-2">
            <code className="break-all">{createdId}</code>
            <CopyButton value={createdId} label="client_id" />
          </p>
          {secret && <SecretNotice secret={secret} onClose={() => setSecret(null)} />}
          <p className="mt-2">
            <Link
              className="underline"
              href={`/settings/applications/${encodeURIComponent(createdId)}`}
            >
              詳細を設定する
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

export function SecretNotice({ secret, onClose }: { secret: string; onClose?: () => void }) {
  return (
    <div className="mt-4 rounded-md border border-danger p-4 text-sm">
      <p className="font-semibold">client secret（この 1 回だけ表示されます）</p>
      <p className="mt-2 flex items-center gap-2">
        <code className="break-all">{secret}</code>
        <CopyButton value={secret} label="secret" />
      </p>
      <p className="mt-2 text-muted-fg">
        保存後は再表示できません。紛失した場合は再生成してください。
      </p>
      {onClose && (
        <Button className="mt-2" variant="outline" size="sm" type="button" onClick={onClose}>
          閉じる
        </Button>
      )}
    </div>
  );
}

export function ApplicationsConsole({
  clients,
  maxClientsPerUser,
}: {
  clients: ApplicationSummary[];
  maxClientsPerUser: number;
}) {
  const csrfToken = useCsrfToken();

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">アプリケーション</h1>
        <p className="mt-2 text-sm text-muted-fg">
          作成した OIDC / OAuth 2.0 クライアントの一覧です（{clients.length} / {maxClientsPerUser}{' '}
          件）。
        </p>
        {clients.length === 0 ? (
          <p className="mt-4 text-sm">まだアプリを作成していません。</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {clients.map((client) => (
              <li
                key={client.clientId}
                className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <h2 className="font-medium">
                    <Link
                      className="underline"
                      href={`/settings/applications/${encodeURIComponent(client.clientId)}`}
                    >
                      {client.name}
                    </Link>
                  </h2>
                  <p className="mt-1 text-xs text-muted-fg">
                    {client.clientType} ・ 運営者: {client.operator} ・ scope:{' '}
                    {client.allowedScopes.join(' ')}
                  </p>
                  <p className="mt-1 text-xs text-muted-fg">
                    接続中のユーザー: {client.grantCount} 名
                    {client.lastUsedAt
                      ? ` ・ 最終利用: ${new Date(client.lastUsedAt).toLocaleString('ja-JP')}`
                      : ''}
                  </p>
                  {!client.active && (
                    <p className="mt-1 text-xs text-danger">このアプリは利用停止されています。</p>
                  )}
                  {!client.isOwner && client.ownerUsername && (
                    <p className="mt-1 text-xs text-muted-fg">登録者: {client.ownerUsername}</p>
                  )}
                </div>
                <Link
                  className="rounded-md border border-border-strong px-3 py-2 text-sm"
                  href={`/settings/applications/${encodeURIComponent(client.clientId)}`}
                >
                  設定する
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ApplicationCreateForm csrfToken={csrfToken} onCreated={() => undefined} />
    </div>
  );
}
