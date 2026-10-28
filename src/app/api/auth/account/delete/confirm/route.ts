import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline, failResponse, handleSuccess } from '@/lib/api/utils';
import { hashToken } from '@/lib/auth/tokens/generate';
import { verifyAndConsumeToken } from '@/lib/auth/tokens/verify';
import { performAccountDeletion } from '@/lib/auth/account-deletion';
import { getRequestClientIp } from '@/lib/auth/session';
import { z } from 'zod';

const confirmSchema = z.object({
  token: z.string().min(1),
});

/**
 * メール確認による退会の確定（§24 / §25）。
 *
 * メールクライアントはリンクを GET で開く。GET は**状態を変えず**、確定用の画面へ
 * 303 で転送するだけにする（`/api/auth/verify-email` と同じ方針）。削除は画面内の POST
 * がトークンを 1 回限り消費したときだけ走る（D-16）。
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const destination = new URL('/account/delete/confirm', request.url);
  if (token) destination.searchParams.set('token', token);
  return NextResponse.redirect(destination, 303);
}

export async function POST(request: NextRequest) {
  return withAuthPipeline(
    request,
    { requireAuth: false },
    async ({ body }) => {
      const { token } = confirmSchema.parse(body);

      const result = await verifyAndConsumeToken(hashToken(token), 'account_deletion');
      if (!result.valid || !result.userId) {
        return failResponse('INVALID_TOKEN', 'リンクが無効か、有効期限が切れています', 400);
      }

      await performAccountDeletion({
        userId: result.userId,
        ip: getRequestClientIp(request),
        userAgent: request.headers.get('user-agent') ?? '',
        metadata: { method: 'email' },
      });

      return handleSuccess({ message: 'アカウントを削除しました' });
    },
  );
}
