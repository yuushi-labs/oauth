'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiClient, ApiClientError } from '@/lib/api/client';
import { isValidTimeZone } from '@/lib/util/datetime';
import { m } from '@/messages/ja';

/**
 * 選択できる代表的なタイムゾーン（§60）。
 * IANA 名の全量は出さず、想定利用者に必要なものを先頭に置く。
 */
const TIME_ZONE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'Asia/Tokyo', label: '日本標準時 (Asia/Tokyo, JST)' },
  { value: 'UTC', label: '協定世界時 (UTC)' },
  { value: 'Asia/Seoul', label: '韓国標準時 (Asia/Seoul)' },
  { value: 'Asia/Shanghai', label: '中国標準時 (Asia/Shanghai)' },
  { value: 'Asia/Singapore', label: 'シンガポール (Asia/Singapore)' },
  { value: 'Asia/Kolkata', label: 'インド標準時 (Asia/Kolkata)' },
  { value: 'Australia/Sydney', label: 'オーストラリア東部 (Australia/Sydney)' },
  { value: 'Europe/London', label: '英国 (Europe/London)' },
  { value: 'Europe/Paris', label: '中央ヨーロッパ (Europe/Paris)' },
  { value: 'America/New_York', label: '米国東部 (America/New_York)' },
  { value: 'America/Los_Angeles', label: '米国西部 (America/Los_Angeles)' },
  { value: 'Pacific/Honolulu', label: 'ハワイ (Pacific/Honolulu)' },
];

/**
 * タイムゾーン設定（§60）。保存は `PATCH /api/auth/preferences`（D-30-07）。
 * 既定は `Asia/Tokyo`。ブラウザのタイムゾーンをそのまま採用する導線も出す。
 */
export function TimezoneForm({ initialTimezone }: { initialTimezone: string }) {
  const [timezone, setTimezone] = React.useState(initialTimezone);
  const [saved, setSaved] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // 一覧に無い（保存済みの）タイムゾーンも選択肢として残す。
  const options = TIME_ZONE_OPTIONS.some((option) => option.value === timezone)
    ? TIME_ZONE_OPTIONS
    : [{ value: timezone, label: timezone }, ...TIME_ZONE_OPTIONS];

  async function save(next: string) {
    setError('');
    setSaved('');
    if (!isValidTimeZone(next)) {
      setError(m('preferences.timezoneFailed'));
      return;
    }
    setBusy(true);
    try {
      await apiClient.patch('/api/auth/preferences', { timezone: next });
      setSaved(next);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : m('preferences.timezoneFailed'));
    } finally {
      setBusy(false);
    }
  }

  function useBrowserTimeZone() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isValidTimeZone(detected)) return;
    setTimezone(detected);
    void save(detected);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <Label className="flex flex-col gap-1">
        {m('preferences.timezone')}
        <select
          className="h-10 w-full rounded-md border border-border-strong bg-bg px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          disabled={busy}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Label>
      <p className="text-xs text-muted-fg">{m('preferences.timezoneHint')}</p>
      {saved && (
        <Alert variant="success" size="sm">
          <AlertDescription>
            {m('preferences.timezoneSaved')}（{saved}）
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="danger" size="sm">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void save(timezone)} disabled={busy || timezone === saved}>
          {busy ? m('common.saving') : m('common.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={useBrowserTimeZone} disabled={busy}>
          {m('preferences.timezoneAuto')}
        </Button>
      </div>
    </div>
  );
}
