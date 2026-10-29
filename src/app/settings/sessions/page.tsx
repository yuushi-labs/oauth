import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth/session';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { resolveTimeZone } from '@/lib/util/datetime';
import { deriveOsLabel } from '@/lib/util/device';
import { requireSettingsUser } from '@/app/settings/layout';
import { SessionsPanel } from '@/components/settings/sessions-panel';
import type { Metadata } from 'next';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('sessions.title') };

export const dynamic = 'force-dynamic';

/**
 * セッション/デバイス管理（§19 / §38）。
 * 認可は layout のサーバ側ガード（requireSettingsUser）に任せる（§49 / D-30-19）。
 * 現在セッションの判定もサーバー側で行い、初回描画から current を正しく付ける（D-30-08）。
 */
export default async function SettingsSessionsPage() {
  const settingsUser = await requireSettingsUser();

  // 現在セッションは Cookie から確定する（クライアントで Cookie を読まない）
  const sessionToken = (await cookies()).get(getSessionCookieName())?.value;
  const session = sessionToken ? await getSession(sessionToken) : null;
  const currentSessionId = session?.id ?? '';

  const [rows, preferences] = await Promise.all([
    listActiveSessionsByUser(settingsUser.id),
    getUserPreferences(settingsUser.id),
  ]);

  const initialSessions = rows
    .map((row) => ({
      id: row.id,
      device_name: row.deviceName ?? 'その他のデバイス',
      os: deriveOsLabel(row.userAgent),
      ip_masked: row.ipMasked ?? null,
      last_seen_at: row.lastSeenAt.toISOString(),
      created_at: row.createdAt.toISOString(),
      current: row.id === currentSessionId,
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) || b.last_seen_at.localeCompare(a.last_seen_at),
    );

  return (
    <main id="main-content" className="flex flex-col gap-6">
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
