import { NextRequest } from 'next/server';
import { withAuthPipeline, handleSuccess } from '@/lib/api/utils';
import { revokeSession } from '@/lib/auth/session';
import { clearSessionCookie, clearAnonCookie } from '@/lib/auth/cookie';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: true },
    async ({ user, session }) => {
      if (session) {
        await revokeSession(session.id, 'logout');
      }
      await clearSessionCookie();
      await clearAnonCookie();

      if (user) {
        await recordSecurityEvent('logout', user.id, getRequestClientIp(request), request.headers.get('user-agent') ?? '');
      }

      return handleSuccess({ message: 'ログアウトしました' });
    },
  );
}
