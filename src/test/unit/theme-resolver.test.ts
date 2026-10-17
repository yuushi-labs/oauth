import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  isThemePreference,
  nextThemePreference,
  normalizeTheme,
  resolveEffectiveTheme,
} from '@/lib/theme/resolver';

describe('theme resolver (spec 39-41)', () => {
  it('既定は system', () => {
    expect(DEFAULT_THEME).toBe('system');
    expect(THEME_STORAGE_KEY).toBe('theme');
    expect(THEME_PREFERENCES).toEqual(['system', 'light', 'dark']);
  });

  it('不正値は system に落とす（localStorage が壊れていても無害）', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('neon')).toBe('system');
    expect(normalizeTheme(null)).toBe('system');
    expect(normalizeTheme(undefined)).toBe('system');
    expect(normalizeTheme(42)).toBe('system');
  });

  it('型ガード', () => {
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('neon')).toBe(false);
  });

  it('system は端末設定に従う（spec 41）', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });

  it('明示指定は端末設定を無視する（spec 39）', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
  });

  it('3択の循環', () => {
    expect(nextThemePreference('system')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
    expect(nextThemePreference('broken' as never)).toBe('light');
  });
});