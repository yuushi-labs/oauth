import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);

  // 基本セキュリティヘッダー (Phase 1)
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');

  // CORS 許可リスト (§47)
  const origin = request.headers.get('Origin');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (origin && appUrl && origin === appUrl) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!api/auth/oauth).*)'],
};