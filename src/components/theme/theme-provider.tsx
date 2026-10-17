'use client';

import * as React from 'react';
import { apiClient } from '@/lib/api/client';
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  normalizeTheme,
  resolveEffectiveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme/resolver';

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => Promise<void>;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/**
 * テーマの唯一のクライアント側実装（§39-42 / D-30-03）。
 * - 初期値は server から渡された user_preferences（ログイン時は localStorage より優先）
 * - theme=system のときだけ matchMedia を購読し、リロードなしで OS 変更に追従（§41）
 * - light/dark を明示選んだ場合は OS 設定を無視する（§39）
 */
export function ThemeProvider({
  initialPreference,
  authenticated,
  children,
}: {
  initialPreference?: ThemePreference;
  authenticated: boolean;
  children: React.ReactNode;
}) {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(
    normalizeTheme(initialPreference ?? DEFAULT_THEME),
  );
  const [resolved, setResolved] = React.useState<ResolvedTheme>('light');

  React.useEffect(() => {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const apply = () => {
      const next = resolveEffectiveTheme(preference, media.matches);
      setResolved(next);
      document.documentElement.dataset.theme = next;
    };
    apply();
    if (preference !== 'system') return undefined;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);

  const setPreference = React.useCallback(
    async (next: ThemePreference) => {
      const previous = preference;
      const previousStorage = readStoredPreference();
      setPreferenceState(next);
      writeStoredPreference(next);
      try {
        if (authenticated) {
          await apiClient.patch<{ theme: ThemePreference }>('/api/auth/preferences', { theme: next });
        }
      } catch {
        // 失敗時は直前の表示へロールバックする
        setPreferenceState(previous);
        writeStoredPreference(previousStorage);
        throw new Error('theme-preference-save-failed');
      }
    },
    [authenticated, preference],
  );

  const value = React.useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function readStoredPreference(): ThemePreference {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function writeStoredPreference(value: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // localStorage 不可（プライベートモード等）でも動作は続行する
  }
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}