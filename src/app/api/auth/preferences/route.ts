import { NextRequest } from 'next/server';
import { withAuthPipeline, handleSuccess } from '@/lib/api/utils';
import { getUserPreferences, upsertUserPreferences } from '@/lib/db/queries/user-preferences';
import { preferencesPatchSchema } from '@/lib/validate/preferences';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { rateLimitKeys } from '@/lib/auth/rate-limit-keys';
import { rateLimitResponse } from '@/lib/api/utils';
import type { UserPreferences } from '@/lib/db/schema';

function toResponse(preferences: UserPreferences) {
  return handleSuccess(
    {
      theme: preferences.theme,
      language: preferences.language,
      timezone: preferences.timezone,
      updated_at: preferences.updatedAt.toISOString(),
    },
    200,
  );
}

export async function GET(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true },
    async ({ user }) => {
      if (!user) throw new Error('unreachable');
      const limit = await rateLimiter.check(
        rateLimitKeys.settingsUser(user.id),
        RATE_LIMITS.settings.window,
        RATE_LIMITS.settings.limit,
        RATE_LIMITS.settings.softLimit,
      );
      if (!limit.allowed) return rateLimitResponse(limit.resetAt);

      const response = toResponse(await getUserPreferences(user.id));
      response.headers.set('Cache-Control', 'no-store');
      return response;
    },
  );
}

export async function PATCH(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true },
    async ({ user, body }) => {
      if (!user) throw new Error('unreachable');
      const patch = preferencesPatchSchema.parse(body);

      const limit = await rateLimiter.check(
        rateLimitKeys.settingsUser(user.id),
        RATE_LIMITS.settings.window,
        RATE_LIMITS.settings.limit,
        RATE_LIMITS.settings.softLimit,
      );
      if (!limit.allowed) return rateLimitResponse(limit.resetAt);

      const updated = await upsertUserPreferences(user.id, patch);
      const response = toResponse(updated);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    },
  );
}