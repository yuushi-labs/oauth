export type UtcDateString = string;

export function nowUtc(): Date {
  return new Date();
}

export function toUtcIso(date: Date = new Date()): UtcDateString {
  return date.toISOString();
}

/** ログ・テスト用に秒精度の UTC 文字列へ整形する（例: 2026-10-04T09:00:00Z）。 */
export function formatUtc(date: Date = new Date()): UtcDateString {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 24 * 60 * 60);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}