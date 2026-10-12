import { ApiError } from '@/lib/errors';
import type { SessionData } from '@/lib/auth/session';

const REAUTH_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5分 (D-14)

export function checkReauth(session: SessionData): void {
  if (!session.reauthVerifiedAt) {
    throw new ApiError('REAUTH_REQUIRED', '本人確認が必要です');
  }
  const elapsed = Date.now() - new Date(session.reauthVerifiedAt).getTime();
  if (elapsed > REAUTH_GRACE_PERIOD_MS) {
    throw new ApiError('REAUTH_REQUIRED', '本人確認の有効期限が切れました');
  }
}

export const REAUTH_GRACE_PERIOD = REAUTH_GRACE_PERIOD_MS;