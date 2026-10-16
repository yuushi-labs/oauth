import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { hashToken } from '@/lib/auth/tokens/generate';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import { updateUser } from '@/lib/db/queries/users';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { getRequestClientIp } from '@/lib/auth/session';
import { z } from 'zod';

const verifySchema = z.object({
  token: z.string().min(1),
});

// Email clients and security scanners open links with GET. Keep that request
// non-mutating and let the user confirm on the application page.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const destination = new URL('/verify-email', request.url);
  if (token) destination.searchParams.set('token', token);
  return NextResponse.redirect(destination, 303);
}

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { token } = verifySchema.parse(body);
      const hash = hashToken(token);
      const result = await verifyAndConsumeToken(hash, 'email_verification');
      if (!result.valid || !result.userId) {
        return failResponse('INVALID_TOKEN', 'リンクが無効か、有効期限が切れています', 400);
      }

      await updateUser(result.userId, { emailVerified: true, status: 'active' });
      await recordSecurityEvent(
        'email_verified',
        result.userId,
        getRequestClientIp(request),
        request.headers.get('user-agent') ?? '',
      );

      return handleSuccess({ message: 'email が認証されました' });
    },
  );
}
