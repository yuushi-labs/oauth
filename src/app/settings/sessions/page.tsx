import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { resolveTimeZone } from '@/lib/util/datetime';
import { deriveOsLabel } from '@/lib/util/device';
import { requireSettingsUser } from '@/app/settings/layout';
import { SessionsPanel } from '@/components/settings/sessions-panel';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

/**
 * セッション/デバイス管理（§19 / §38）。
 * 認可は layout のサーバ側ガード（requireSettingsUser）に任せる（§49 / D-30-19）。
 * 現在セッションの判定はサーバ側で行い、current フラグを渡す（D-30-08）。
 */
export default async function SettingsSessionsPage() {
  const user = await requireSettingsUser();
  const [rows, preferences] = await Promise.all([
    listActiveSessionsByUser(user.id),
    getUserPreferences(user.id),
  ]);

  const initialSessions = rows
    .map((row) => ({
      id: row.id,
      device_name: row.deviceName ?? 'その他のデバイス',
      os: deriveOsLabel(row.userAgent),
      ip_masked: row.ipMasked ?? null,
      last_seen_at: row.lastSeenAt.toISOString(),
      created_at: row.createdAt.toISOString(),
      current: false,
    }))
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">{m('sessions.title')}</h1>
        <p className="mt-2 text-sm text-muted-fg">{m('security.devices')}</p>
      </header>
      <SessionsPanel
        initialSessions={initialSessions}
        timezone={resolveTimeZone(preferences.timezone)}
      />
    </main>
  );
}