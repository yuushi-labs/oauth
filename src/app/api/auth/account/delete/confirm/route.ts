import { NextRequest } from 'next/server';
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
 * メール確認による退会の確定（内部実装・残置・D-40-05）。
 *
 * メール送受信の廃止に伴い画面と GET 転送は撤去した。削除は POST がトークンを 1 回限り
 * 消費したときだけ走る（D-16）。現在は UI からの導線が無い（設定画面の削除は
 * パスワード / 2FA / Passkey の強い再認証のみ・D-40-04）。
 */
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
