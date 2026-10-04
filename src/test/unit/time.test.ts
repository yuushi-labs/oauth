import { describe, expect, it } from 'vitest';
import { addDays, addSeconds, formatUtc, isExpired, nowUtc, toUtcIso } from '@/lib/util/time';

describe('nowUtc / toUtcIso', () => {
  it('UTC の ISO 形式を返す', () => {
    const iso = toUtcIso(new Date('2026-10-04T09:00:00Z'));
    expect(iso).toBe('2026-10-04T09:00:00.000Z');
  });

  it('nowUtc は Date を返す', () => {
    expect(nowUtc()).toBeInstanceOf(Date);
  });
});

describe('formatUtc', () => {
  it('秒精度の UTC 表記になる', () => {
    expect(formatUtc(new Date('2026-10-04T09:00:00.123Z'))).toBe('2026-10-04T09:00:00Z');
  });

  it('タイムゾーンRegardless に UTC で出力する', () => {
    const date = new Date('2026-01-01T00:00:00+09:00');
    expect(formatUtc(date)).toBe('2025-12-31T15:00:00Z');
  });
});

describe('addSeconds / addDays', () => {
  const base = new Date('2026-10-04T00:00:00Z');

  it('秒を加算できる（トークン TTL 用的）', () => {
    expect(addSeconds(base, 30 * 60).toISOString()).toBe('2026-10-04T00:30:00.000Z');
  });

  it('日を加算できる（セッション 30日/90日用的）', () => {
    expect(addDays(base, 30).toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(addDays(base, 90).toISOString()).toBe('2027-01-02T00:00:00.000Z');
  });
});

describe('isExpired', () => {
  const now = new Date('2026-10-04T00:00:00Z');

  it('期限切れなら true', () => {
    expect(isExpired(new Date('2026-10-03T23:59:59Z'), now)).toBe(true);
  });

  it('期限切れでなければ false', () => {
    expect(isExpired(new Date('2026-10-04T00:00:01Z'), now)).toBe(false);
  });

  it('境界（同時刻）は期限切れ扱い', () => {
    expect(isExpired(now, now)).toBe(true);
  });
});