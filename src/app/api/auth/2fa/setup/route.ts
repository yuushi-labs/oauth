import { NextRequest } from 'next/server';
import { withAuthPipeline, handleSuccess, failResponse } from '@/lib/api/utils';
import { findTotpByUserId, upsertTotpPending } from '@/lib/db/queries/totp';
import { generateTotpSecret, buildOtpauthUri } from '@/lib/auth/totp';
import { otpauthUriToSvg } from '@/lib/auth/totp-qr';
import { APP_NAME } from '@/config/app';

/**
 * POST /api/auth/2fa/setup — secret を発行し、QR と otpauth URI を返す。
 *
 * - 有効化済みなら 409 TOTP_ALREADY_ENABLED（D-33-16）。未確認 secret は上書きを許す（再 setup）。
 * - secret を返すのはこの 1 回だけ（応答を保存し損ねたらやり直す）。
 * - メール確認は要求しない（D-40-02。登録時に即時有効化されるため）。
 */
export async function POST(request: NextRequest) {
  return withAuthPipeline(request, { requireAuth: true }, async ({ user }) => {
    if (!user) return failResponse('SESSION_EXPIRED', 'セッションの有効期限が切れました', 401);

    const existing = await findTotpByUserId(user.id);
    if (existing?.enabled) {
      return failResponse('TOTP_ALREADY_ENABLED', '2 段階認証は既に有効です', 409);
    }

    const { base32, encrypted } = generateTotpSecret();
    await upsertTotpPending(user.id, encrypted);

    const otpauthUri = buildOtpauthUri({ issuer: APP_NAME, label: user.username, secretBase32: base32 });
    const qrSvg = await otpauthUriToSvg(otpauthUri);

    return handleSuccess({ secret: base32, otpauth_uri: otpauthUri, qr_svg: qrSvg });
  });
}
