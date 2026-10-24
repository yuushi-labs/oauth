import { requireSettingsUser } from '@/app/settings/layout';
import { findUserById } from '@/lib/db/queries/users';
import { listActiveSessionsByUser } from '@/lib/db/queries/sessions';
import { getUserPreferences } from '@/lib/db/queries/user-preferences';
import { listRecentSecurityEventsByUser } from '@/lib/db/queries/security-events';
import { listAccountsByUser } from '@/lib/auth/oauth/accounts';
import { findTotpByUserId } from '@/lib/db/queries/totp';
import { countUnusedRecoveryCodes } from '@/lib/auth/recovery-codes';
import { availableStrongReauthMethods } from '@/lib/auth/strong-reauth';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';
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
  const [user, sessions, events, preferences, linkedRows, totpRow] = await Promise.all([
    findUserById(settingsUser.id),
    listActiveSessionsByUser(settingsUser.id),
    listRecentSecurityEventsByUser(settingsUser.id, EVENT_LIMIT),
    getUserPreferences(settingsUser.id),
    listAccountsByUser(settingsUser.id),
    findTotpByUserId(settingsUser.id),
  ]);
  if (!user) return null;

  const twoFactorEnabled = Boolean(totpRow?.enabled);
  const twoFactor = {
    enabled: twoFactorEnabled,
    recovery_codes_remaining: twoFactorEnabled ? await countUnusedRecoveryCodes(user.id) : 0,
    strong_reauth_methods: availableStrongReauthMethods(user),
  };

  const timezone = resolveTimeZone(preferences.timezone);
  const providerLabels = new Map<string, string>(
    OAUTH_PROVIDER_REGISTRY.map((p) => [p.id as string, p.label]),
  );
  const linkedAccountLabels = linkedRows.map((row) => providerLabels.get(row.provider) ?? row.provider);
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
        linkedAccounts={linkedRows.length}
        linkedAccountLabels={linkedAccountLabels}
        twoFactor={twoFactor}
      />
    </main>
  );
}