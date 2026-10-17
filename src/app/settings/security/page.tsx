import { requireSettingsUser } from '@/app/settings/layout';
import { findUserById } from '@/lib/db/queries/users';
import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { listRecentSecurityEventsByUser } from '@/lib/db/queries/security-events';
import { resolveTimeZone } from '@/lib/util/datetime';
import { deriveOsLabel } from '@/lib/util/device';
import { SecurityOverview } from '@/components/settings/security-overview';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

const EVENT_LIMIT = 10;

/**
 * セキュリティ設定画面（§37）。
 *
 * §37 のレイアウトを順に並べる。2 段階認証・Passkey・連携は未実装（Phase 5/6/4）のため
 * 状態だけを如实表示し、導線は出さない（D-30-16）。
 */
export default async function SettingsSecurityPage() {
  const settingsUser = await requireSettingsUser();
  const [user, sessions, events, preferences] = await Promise.all([
    findUserById(settingsUser.id),
    listActiveSessionsByUser(settingsUser.id),
    listRecentSecurityEventsByUser(settingsUser.id, EVENT_LIMIT),
    getUserPreferences(settingsUser.id),
  ]);
  if (!user) return null;

  const timezone = resolveTimeZone(preferences.timezone);
  const passwordChangedAt = (user.passwordChangedAt ?? user.createdAt).toISOString();
  const deviceRows = sessions.slice(0, 3).map((row) => ({
    id: row.id,
    device_name: row.deviceName ?? 'その他のデバイス',
    os: deriveOsLabel(row.userAgent),
    ip_masked: row.ipMasked ?? null,
    last_seen_at: row.lastSeenAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    current: row.id === settingsUser.id,
  }));

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">{m('security.title')}</h1>
      </header>
      <SecurityOverview
        email={user.email}
        emailVerified={user.emailVerified}
        passwordChangedAt={passwordChangedAt}
        sessions={deviceRows}
        events={events.map((event) => ({
          eventType: event.eventType,
          ipMasked: event.ipMasked,
          createdAt: event.createdAt.toISOString(),
        }))}
        timezone={timezone}
        eventLimit={EVENT_LIMIT}
      />
    </main>
  );
}