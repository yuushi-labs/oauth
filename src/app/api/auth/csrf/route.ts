import { NextRequest, NextResponse } from 'next/server';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import { generateAnonCsrfSecret, getAnonCsrfSecret, getAnonCookieName, getSessionCookieName, setAnonCookie } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { ok } from '@/lib/errors';

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get(getSessionCookieName())?.value;
  if (sessionToken) {
    const session = await getSession(sessionToken);
    if (session) {
      return NextResponse.json(ok({ csrfToken: deriveCsrfToken(session) }), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  }

  const anonCookie = request.cookies.get(getAnonCookieName())?.value ?? null;
  let csrfToken = getAnonCsrfSecret(anonCookie);
  if (!csrfToken) {
    csrfToken = generateAnonCsrfSecret();
    await setAnonCookie(csrfToken);
  }

  return NextResponse.json(ok({ csrfToken }), { headers: { 'Cache-Control': 'no-store' } });
}
