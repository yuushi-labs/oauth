'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CopyButton,
  postJson,
  SecretNotice,
  useCsrfToken,
} from '@/app/settings/applications/applications-console';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatLocalDateTime } from '@/lib/util/datetime';

export type ApplicationDetailData = {
  clientId: string;
  name: string;
  operator: string;
  clientType: 'public' | 'confidential';
  redirectUris: string[];
  allowedScopes: string[];
  webOrigins: string[];
  active: boolean;
  createdAt: string;
  ownerUsername: string | null;
  issuer: string;
  discoveryUrl: string;
  testRedirectUri: string;
};

const scopeNames: Record<string, string> = {
  openid: 'アカウントID',
  profile: 'プロフィール',
  email: '確認済みメールアドレス',
};

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ReauthDialog({
  action,
  title,
  description,
  onClose,
  csrfToken,
}: {
  action: () => Promise<{ ok: boolean; message: string; data?: unknown }>;
  title: string;
  description: string;
  onClose: () => void;
  csrfToken: string;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setError('');
    setBusy(true);
    const reauth = await postJson<{ message: string }>('/api/auth/reauth', { password }, csrfToken);
    if (!reauth.ok) {
      setBusy(false);
      setError(reauth.message);
      return;
    }
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
  }

  return (
    <div className="rounded-md border border-border p-4 text-sm">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-muted-fg">{description}</p>
      <label className="mt-3 grid gap-1">
        <span>パスワードで本人確認</span>
        <Input
          autoComplete="current-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error && (
        <p className="mt-2 text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button loading={busy} disabled={!password} onClick={() => void confirm()}>
          実行する
        </Button>
        <Button variant="outline" onClick={onClose}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}

export function ApplicationDetail({ client }: { client: ApplicationDetailData }) {
  const csrfToken = useCsrfToken();
  const router = useRouter();
  const [name, setName] = useState(client.name);
  const [operator, setOperator] = useState(client.operator);
  const [redirectUris, setRedirectUris] = useState(client.redirectUris.join('\n'));
  const [webOrigins, setWebOrigins] = useState(client.webOrigins.join('\n'));
  const [scopes, setScopes] = useState<string[]>(client.allowedScopes);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'none' | 'rotate' | 'revoke'>('none');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [busy, setBusy] = useState(false);

  const testRedirectRegistered = lines(redirectUris).includes(client.testRedirectUri);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setError('');
    setBusy(true);
    const result = await postJson(
      `/api/auth/oidc/clients/${encodeURIComponent(client.clientId)}`,
      { name, operator, redirectUris: lines(redirectUris), webOrigins: lines(webOrigins), scopes },
      csrfToken,
      'PATCH',
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMessage('保存しました。');
    router.refresh();
  }

  async function rotateSecret() {
    setError('');
    setMessage('');
    setBusy(true);
    const result = await postJson<{ clientSecret: string }>(
      `/api/auth/oidc/clients/${encodeURIComponent(client.clientId)}/secret`,
      {},
      csrfToken,
    );
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.message);
      return { ok: false, message: result.message };
    }
    setSecret(result.data.clientSecret);
    setMessage('client secret を再生成しました。従来の secret は無効になりました。');
    return { ok: true, message: result.message, data: result.data };
  }

  async function revoke() {
    setError('');
    setBusy(true);
    const result = await postJson<{ revokedGrantCount: number }>(
      `/api/auth/oidc/clients/${encodeURIComponent(client.clientId)}`,
      {},
      csrfToken,
      'DELETE',
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return { ok: false, message: result.message };
    }
    router.refresh();
    return { ok: true, message: result.message, data: result.data };
  }

  async function runTest() {
    setError('');
    setMessage('');
    setBusy(true);
    const result = await postJson<{ authorizeUrl: string }>(
      `/api/auth/oidc/clients/${encodeURIComponent(client.clientId)}/test/start`,
      client.clientType === 'confidential' ? { client_secret: clientSecretInput } : {},
      csrfToken,
    );
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.message);
      return;
    }
    window.location.assign(result.data.authorizeUrl);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{client.name}</h1>
        <p className="mt-1 text-xs text-muted-fg">
          種別: {client.clientType}（作成後は変更できません） ・ 作成日:{' '}
          {formatLocalDateTime(client.createdAt)}
          {client.ownerUsername
            ? ` ・ 登録者: ${client.ownerUsername}`
            : ' ・ 登録者: 運営者（CLI 登録）'}
        </p>
        <dl className="mt-4 grid gap-3 text-sm">
          <div>
            <dt className="text-muted-fg">issuer</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all">{client.issuer}</code>
              <CopyButton value={client.issuer} label="issuer" />
            </dd>
          </div>
          <div>
            <dt className="text-muted-fg">Discovery URL</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all">{client.discoveryUrl}</code>
              <CopyButton value={client.discoveryUrl} label="Discovery URL" />
            </dd>
          </div>
          <div>
            <dt className="text-muted-fg">client_id</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all">{client.clientId}</code>
              <CopyButton value={client.clientId} label="client_id" />
            </dd>
          </div>
        </dl>
        {!client.active && (
          <p className="mt-4 text-sm text-danger">このアプリは利用停止されています。</p>
        )}
      </section>

      <form className="rounded-lg border border-border bg-card p-6" onSubmit={save}>
        <h2 className="text-lg font-semibold">設定</h2>
        <div className="mt-4 grid gap-4">
          <label className="grid gap-1 text-sm">
            <span>アプリ名</span>
            <Input
              maxLength={100}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>運営者名</span>
            <Input
              maxLength={100}
              required
              value={operator}
              onChange={(event) => setOperator(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>リダイレクト URI（1行に 1 つ）</span>
            <Textarea
              rows={4}
              required
              value={redirectUris}
              onChange={(event) => setRedirectUris(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>
              Web origin（
              {client.clientType === 'public' ? 'public のみ指定可' : 'confidential では指定不可'}）
            </span>
            <Textarea
              rows={2}
              disabled={client.clientType === 'confidential'}
              value={webOrigins}
              onChange={(event) => setWebOrigins(event.target.value)}
            />
          </label>
          <fieldset className="grid gap-1 text-sm">
            <legend>許可する scope</legend>
            {Object.entries(scopeNames).map(([scope, label]) => (
              <label key={scope} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  disabled={scope === 'openid'}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
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
            <p className="text-xs text-muted-fg">
              scope を広げても既存の同意は変わりません。新 scope は再同意時に付与されます。
            </p>
          </fieldset>
        </div>
        {message && (
          <p className="mt-4 text-sm" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="mt-4 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button className="mt-4" type="submit" loading={busy} disabled={!csrfToken}>
          保存する
        </Button>
        {secret && <SecretNotice secret={secret} onClose={() => setSecret(null)} />}
      </form>

      {client.clientType === 'confidential' && client.active && (
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">client secret の再生成</h2>
          <p className="mt-2 text-sm text-muted-fg">
            再生成すると現在の secret は直ちに無効になります。本人確認が必要です。
          </p>
          <Button
            className="mt-4"
            variant="outline"
            disabled={busy || !csrfToken}
            onClick={() => setDialog('rotate')}
          >
            再生成する
          </Button>
          {dialog === 'rotate' && (
            <div className="mt-4">
              <ReauthDialog
                action={rotateSecret}
                csrfToken={csrfToken}
                description="client secret を再生成します。既存の secret は失効します。"
                onClose={() => setDialog('none')}
                title="本人確認"
              />
            </div>
          )}
        </section>
      )}

      {client.active && (
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">接続テスト</h2>
          <p className="mt-2 text-sm text-muted-fg">
            許可した scope とリダイレクト URI・secret
            を使って実際に接続し、返ってくるユーザー情報を確認します。
          </p>
          <p className="mt-3 text-sm">
            まず次の URI をリダイレクト URI に追加してください（1行に 1 つ・手動追加）。
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all">{client.testRedirectUri}</code>
            <CopyButton value={client.testRedirectUri} label="テスト用 URI" />
          </p>
          {!testRedirectRegistered && (
            <p className="mt-2 text-sm text-danger">
              テスト用 URI がリダイレクト URI
              に登録されていません。上の「保存する」で追加してください。
            </p>
          )}
          {client.clientType === 'confidential' && (
            <label className="mt-4 grid gap-1 text-sm">
              <span>client secret（このテストのためだけに送信します。保存されません）</span>
              <Input
                autoComplete="off"
                type="password"
                value={clientSecretInput}
                onChange={(event) => setClientSecretInput(event.target.value)}
              />
            </label>
          )}
          <Button
            className="mt-4"
            variant="outline"
            loading={busy}
            disabled={
              !csrfToken ||
              !testRedirectRegistered ||
              (client.clientType === 'confidential' && !clientSecretInput)
            }
            onClick={() => void runTest()}
          >
            接続テストを実行
          </Button>
          {error && (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      {client.active && (
        <section className="rounded-lg border border-danger bg-card p-6">
          <h2 className="text-lg font-semibold">利用を停止する</h2>
          <p className="mt-2 text-sm text-muted-fg">
            このアプリと、発行済みのトークン・連携をすべて無効にします。元に戻すことはできません。
          </p>
          <Button
            className="mt-4"
            variant="destructive"
            disabled={busy || !csrfToken}
            onClick={() => setDialog('revoke')}
          >
            利用を停止する
          </Button>
          {dialog === 'revoke' && (
            <div className="mt-4">
              <ReauthDialog
                action={revoke}
                csrfToken={csrfToken}
                description="アプリの利用を停止し、既存の連携とトークンを破棄します。"
                onClose={() => setDialog('none')}
                title="本人確認"
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
