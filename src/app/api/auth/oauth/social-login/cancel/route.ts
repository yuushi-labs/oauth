import { NextRequest, NextResponse } from 'next/server';
import { withAuthPipeline } from '@/lib/api/utils';
import { buildClearedSocialClaimCookie } from '@/lib/auth/cookie';

export const dynamic = 'force-dynamic';

/**
 * 連携の確認を辞退する（Phase 4-B）。
 *
 * claim は DB に残るが TTL（10 分）で失効するし、`purge-expired` でも消える。
 * ここで Cookie だけを消して `/login` に戻し、二次流入を防ぐ。
 */
export async function POST(request: NextRequest): Promise<Response> {
  return withAuthPipeline(request, { requireAuth: false }, async () => {
    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000';
    return NextResponse.redirect(new URL('/login', base), {
      status: 303,
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': buildClearedSocialClaimCookie(),
      },
    });
  });
}