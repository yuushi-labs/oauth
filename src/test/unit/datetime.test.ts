import { describe, expect, it } from 'vitest';
import { formatLocalDateTime, isValidTimeZone, resolveTimeZone } from '@/lib/util/datetime';

describe('formatLocalDateTime (spec 38 / 60)', () => {
  const utc = new Date('2026-10-03T20:30:00Z');

  it('§38 の書式 YYYY/MM/DD HH:mm', () => {
    expect(formatLocalDateTime(utc, 'UTC')).toBe('2026/10/03 20:30');
  });

  it('ユーザー設定のタイムゾーンへ変換する', () => {
    expect(formatLocalDateTime(utc, 'Asia/Tokyo')).toBe('2026/10/04 05:30');
  });

  it('不正なタイムゾーンは例外を出さず既定（Asia/Tokyo）へ落とす', () => {
    expect(formatLocalDateTime(utc, 'Mars/Phobos')).toBe('2026/10/04 05:30');
    expect(formatLocalDateTime(utc, undefined)).toBe('2026/10/04 05:30');
    expect(formatLocalDateTime(utc, null)).toBe('2026/10/04 05:30');
  });

  it('文字列を受け取れる', () => {
    expect(formatLocalDateTime('2026-10-03T20:30:00Z', 'UTC')).toBe('2026/10/03 20:30');
  });

  it('不正な日付は空文字（例外にしない）', () => {
    expect(formatLocalDateTime('not-a-date', 'UTC')).toBe('');
  });
});

describe('time zone helpers', () => {
  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it('resolveTimeZone は既定を Asia/Tokyo にする', () => {
    expect(resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(resolveTimeZone('Mars/Phobos')).toBe('Asia/Tokyo');
  });
});