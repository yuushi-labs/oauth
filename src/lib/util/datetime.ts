/**
 * 日時の表示整形（§60 / D-30-17）。
 * DB は UTC 保存、表示はユーザー設定のタイムゾーンへ変換する。
 * 表示形式は §38 の `2026/10/03 20:30`。
 *
 * 既定は `Asia/Tokyo`。仕様 §60 の例も `Asia/Tokyo` で、想定利用者が日本のため。
 */
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 不正なタイムゾーンは黙って既定（Asia/Tokyo）へ落とす（例外を画面へ漏らさない）。 */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? timeZone! : DEFAULT_TIME_ZONE;
}

export function formatLocalDateTime(
  value: Date | string,
  timeZone: string | null | undefined = DEFAULT_TIME_ZONE,
): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: resolveTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}