'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme/theme-provider';
import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme/resolver';
import { cn } from '@/lib/cn';
import { m } from '@/messages/ja';

const LABELS: Record<ThemePreference, { label: string; Icon: typeof Sun; hint: string }> = {
  system: { label: m('theme.system'), Icon: Monitor, hint: m('theme.systemHint') },
  light: { label: m('theme.light'), Icon: Sun, hint: m('theme.lightHint') },
  dark: { label: m('theme.dark'), Icon: Moon, hint: m('theme.darkHint') },
};

/**
 * テーマ 3 択（§39）。状態は色＋アイコン＋テキストで表現し、色だけに依存しない（§42）。
 */
export function ThemeToggle({ className, onError }: { className?: string; onError?: (error: unknown) => void }) {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div
      role="group"
      aria-label={m('theme.toggleLabel')}
      className={cn('inline-flex shrink-0 rounded-md border border-border bg-card p-1', className)}
    >
      {THEME_PREFERENCES.map((value) => {
        const { label, Icon } = LABELS[value];
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            title={LABELS[value].hint}
            onClick={() => {
              void setPreference(value).catch((error) => onError?.(error));
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-hover text-fg' : 'text-muted-fg hover:text-fg',
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            <span className="whitespace-nowrap">{label}</span>
            {active && <span className="sr-only">{m('theme.selected')}</span>}
          </button>
        );
      })}
      <span className="sr-only" aria-live="polite">
        {m('theme.currentResolved', { value: resolved === 'dark' ? m('theme.dark') : m('theme.light') })}
      </span>
    </div>
  );
}