import { getDb } from '@/lib/db/client';
import { userPreferences, type UserPreferences } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const DEFAULT_PREFERENCES = {
  theme: 'system',
  language: 'ja',
  timezone: 'UTC',
} as const;

function normalizeTimezone(value: string | null | undefined): string {
  if (!value) return DEFAULT_PREFERENCES.timezone;
  try {
    // 不正な IANA 名は例外になるので既定へ落とす（§60）
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_PREFERENCES.timezone;
  }
}

/** 行が無い場合は既定値を返し、初回 PATCH で初めて行が作られる。 */
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const db = getDb();
  const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (!row) {
    return {
      userId,
      theme: DEFAULT_PREFERENCES.theme,
      language: DEFAULT_PREFERENCES.language,
      timezone: DEFAULT_PREFERENCES.timezone,
      updatedAt: new Date(0),
    };
  }
  return { ...row, timezone: normalizeTimezone(row.timezone) };
}

export type PreferencePatch = {
  theme?: UserPreferences['theme'];
  language?: UserPreferences['language'];
  timezone?: string;
};

export async function upsertUserPreferences(
  userId: string,
  patch: PreferencePatch,
): Promise<UserPreferences> {
  const db = getDb();
  const values = {
    ...(patch.theme ? { theme: patch.theme } : {}),
    ...(patch.language ? { language: patch.language } : {}),
    ...(patch.timezone ? { timezone: normalizeTimezone(patch.timezone) } : {}),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(userPreferences)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userPreferences.userId, set: values })
    .returning();
  return row!;
}