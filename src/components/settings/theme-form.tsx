'use client';

import * as React from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme/theme-provider';
import { useToast } from '@/components/ui/toast';
import { TimezoneForm } from '@/components/settings/timezone-form';
import { cn } from '@/lib/cn';
import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme/resolver';
import { m } from '@/messages/ja';

const OPTIONS: { value: ThemePreference; label: string; hint: string; Icon: typeof Sun }[] = [
  { value: 'system', label: m('theme.system'), hint: m('theme.systemHint'), Icon: Monitor },
  { value: 'light', label: m('theme.light'), hint: m('theme.lightHint'), Icon: Sun },
  { value: 'dark', label: m('theme.dark'), hint: m('theme.darkHint'), Icon: Moon },
];

/**
 * テーマ 3 択（§39）。選択＝保存で 1 選択 1 リクエスト。失敗時は前の値へ戻す。
 * 状態は色＋アイコン＋テキストで示す（§42）。
 */
export function ThemeForm({ initialTheme, timezone }: { initialTheme: string; timezone: string }) {
  const { preference, resolved, setPreference } = useTheme();
  const { push } = useToast();
  const [busy, setBusy] = React.useState<ThemePreference | null>(null);
  const normalized = (THEME_PREFERENCES as readonly string[]).includes(initialTheme)
    ? (initialTheme as ThemePreference)
    : preference;

  async function choose(next: ThemePreference) {
    if (next === preference || busy) return;
    setBusy(next);
    try {
      await setPreference(next);
    } catch {
      push({ variant: 'danger', title: m('theme.saveFailed') });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-fg">{m('theme.title')}</legend>
        {OPTIONS.map(({ value, label, hint, Icon }) => {
          const active = normalized === value;
          return (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-md border p-4',
                active ? 'border-primary bg-hover' : 'border-border-strong bg-card',
              )}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={active}
                disabled={busy !== null}
                onChange={() => void choose(value)}
                className="size-4"
              />
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="flex flex-col">
                <span className="text-sm font-medium text-fg">{label}</span>
                <span className="text-xs text-muted-fg">{hint}</span>
              </span>
              {active && <Check aria-hidden className="ml-auto size-4 text-success" />}
            </label>
          );
        })}
      </fieldset>

      <p className="text-sm text-muted-fg" aria-live="polite">
        {m('theme.currentPreference')}: {OPTIONS.find((option) => option.value === normalized)?.label}
        （{m('theme.currentResolved', {
          value: resolved === 'dark' ? m('theme.dark') : m('theme.light'),
        })}）
      </p>

      <TimezoneForm initialTimezone={timezone} />
    </div>
  );
}