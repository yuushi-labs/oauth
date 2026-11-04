import Link from 'next/link';
import { BadgeCheck, KeyRound, Link2, MonitorSmartphone, Plug } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TwoFactorPanel } from '@/components/settings/two-factor-panel';
import { PasskeyPanel, type PasskeyRow } from '@/components/settings/passkey-panel';
import { formatLocalDateTime } from '@/lib/util/datetime';
import type { SessionRow } from '@/components/settings/session-list';
import { m } from '@/messages/ja';

type EventRow = { eventType: string; ipMasked: string | null; createdAt: string };

import { messages } from '@/messages/ja';

const EVENT_LABELS: Record<string, string> = messages.ui.security.eventLabels;

export function SecurityOverview({
  email,
  passwordChangedAt,
  sessions,
  events,
  timezone,
  eventLimit,
  linkedAccounts,
  linkedAccountLabels,
  twoFactor,
  passkeys,
  passwordSet,
}: {
  email: string;
  passwordChangedAt: string;
  sessions: SessionRow[];
  events: EventRow[];
  timezone: string;
  eventLimit: number;
  linkedAccounts: number;
  linkedAccountLabels: string[];
  twoFactor: { enabled: boolean; recovery_codes_remaining: number; strong_reauth_methods: string[] };
  passkeys: PasskeyRow[];
  passwordSet: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* 1. パスワード */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-muted-fg" />
            {m('settings.password')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 pt-0">
          <p className="text-sm text-muted-fg">
            {m('security.passwordChangedAt')}:{' '}
            <time dateTime={passwordChangedAt}>{formatLocalDateTime(passwordChangedAt, timezone)}</time>
          </p>
          <Link
            className="inline-flex h-8 items-center justify-center rounded-md border border-border-strong px-3 text-xs font-medium text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href="/settings/password"
          >
            {m('security.changePassword')}
          </Link>
        </CardContent>
      </Card>

      {/* 2. メールアドレス（表示のみ。メール確認・変更は廃止・D-40-04）*/}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <BadgeCheck aria-hidden className="size-4 text-muted-fg" />
            {m('security.email')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm">{email}</p>
        </CardContent>
      </Card>

      {/* 3. 2 段階認証（Phase 5 で実装済み）*/}
      <TwoFactorPanel initial={twoFactor} />

      {/* 4. Passkey（Phase 6）*/}
      <PasskeyPanel
        initial={passkeys}
        methods={twoFactor.strong_reauth_methods}
        timezone={timezone}
        passwordSet={passwordSet}
        twoFactorEnabled={twoFactor.enabled}
      />

      {/* 5. 連携アカウント（Phase 4 で実装済み・実際の件数と導線を出す）*/}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <Link2 aria-hidden className="size-4 text-muted-fg" />
            {m('security.linkedAccounts')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 pt-0">
          <p className="text-sm text-fg">
            {linkedAccounts > 0
              ? m('oauth.count', { count: linkedAccounts })
              : m('security.notLinked')}
          </p>
          {linkedAccountLabels.length > 0 && (
            <span className="text-xs text-muted-fg">{linkedAccountLabels.join('、')}</span>
          )}
          <Link
            className="inline-flex h-8 items-center justify-center rounded-md border border-border-strong px-3 text-xs font-medium text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href="/settings/connected-accounts"
          >
            {m('oauth.viewAll')}
          </Link>
        </CardContent>
      </Card>

      {/* 5b. OIDC クライアント（既存 M2.6 への導線）*/}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <Plug aria-hidden className="size-4 text-muted-fg" />
            {m('security.oidcClients')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-fg">{m('security.oidcClientsHint')}</p>
          <Link
            className="mt-2 inline-block text-sm text-primary underline"
            href="/settings/applications"
          >
            {m('settings.applications')}
          </Link>
        </CardContent>
      </Card>

      {/* 6. ログイン中のデバイス */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone aria-hidden className="size-4 text-muted-fg" />
            {m('security.devices')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-fg">{m('security.noEvents')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sessions.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{row.device_name}</span>
                  {row.os && <span className="text-xs text-muted-fg">{row.os}</span>}
                  {row.ip_masked && <span className="text-xs text-muted-fg">{row.ip_masked}</span>}
                  <time className="text-xs text-muted-fg" dateTime={row.last_seen_at}>
                    {formatLocalDateTime(row.last_seen_at, timezone)}
                  </time>
                </li>
              ))}
            </ul>
          )}
          <Link className="mt-1 text-sm text-primary underline" href="/settings/sessions">
            {m('security.viewAllDevices')}
          </Link>
        </CardContent>
      </Card>

      {/* 7-8. 最近のセキュリティイベント（読み取り専用）*/}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{m('security.recentEvents')}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {events.length === 0 ? (
            <p className="text-sm text-muted-fg">{m('security.noEvents')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {events.map((event) => (
                <li key={`${event.eventType}-${event.createdAt}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {EVENT_LABELS[event.eventType] ?? event.eventType}
                  </span>
                  {event.ipMasked && <span className="text-xs text-muted-fg">{event.ipMasked}</span>}
                  <time className="text-xs text-muted-fg" dateTime={event.createdAt}>
                    {formatLocalDateTime(event.createdAt, timezone)}
                  </time>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-fg">
            {m('security.recentEventsHint', { n: eventLimit })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}