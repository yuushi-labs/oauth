import { requireSettingsUser } from '@/app/settings/layout';
import { listAccountsByUser } from '@/lib/auth/oauth/accounts';
import { configuredOAuthProviders } from '@/lib/auth/oauth/registry';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { ConnectedAccountsPanel } from '@/components/settings/connected-accounts-panel';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

/**
 * 連携アカウント管理（§11 / §37）。
 *
 * 認可は layout のサーバ側ガード（requireSettingsUser）に任せる。
 * 利用者に見せるのは自分の連携だけ（owner 確認はクエリ側にも入れてある・§49）。
 */
export default async function SettingsConnectedAccountsPage() {
  const settingsUser = await requireSettingsUser();

  const [rows, preferences] = await Promise.all([
    listAccountsByUser(settingsUser.id),
    getUserPreferences(settingsUser.id),
  ]);

  // サーバー側で process.env を読み、**id と label だけ**をクライアントへ渡す。
  // client_secret などの機密値がクライアントバンドルへ入らないようにする（§45）。
  const available = configuredOAuthProviders(process.env).map((provider) => ({
    id: provider.id,
    label: provider.label,
  }));

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">{m('oauth.title')}</h1>
        <p className="mt-2 text-sm text-muted-fg">{m('oauth.description')}</p>
        <p className="mt-1 text-xs text-muted-fg">{m('oauth.securityNotice')}</p>
      </header>
      <ConnectedAccountsPanel
        initialAccounts={rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          provider_label: available.find((p) => p.id === row.provider)?.label ?? row.provider,
          provider_email: row.providerEmail,
          created_at: row.createdAt.toISOString(),
          last_used_at: row.lastUsedAt.toISOString(),
        }))}
        availableProviders={available}
        timezone={preferences.timezone}
      />
    </main>
  );
}