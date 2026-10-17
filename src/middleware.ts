import { NextRequest, NextResponse } from 'next/server';
import { configuredOriginList, isTrustedOrigin } from '@/lib/auth/origin';

function contentSecurityPolicy(nonce: string): string {
  const scriptDirective = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // Next.js Fast Refresh uses eval-based source maps in development only.
    ...(process.env.NODE_ENV === 'development' ? ["'unsafe-eval'"] : []),
  ].join(' ');
  return [
  "default-src 'self'",
  scriptDirective,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ].join('; ');
}

function isHttps(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const trustForwarded = Number(process.env.TRUSTED_PROXY_HOPS ?? '0') > 0;
  const forwardedProto = trustForwarded ? request.headers.get('x-forwarded-proto') : null;
  const protocol = forwardedProto?.split(',')[0]?.trim().toLowerCase() ?? request.nextUrl.protocol.replace(':', '');
  return protocol === 'https';
}

function httpsRedirect(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== 'production' || ['localhost', '127.0.0.1', '[::1]'].includes(request.nextUrl.hostname)) return null;
  if (isHttps(request)) return null;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return new NextResponse('HTTPS required', { status: 400 });
  let canonical: URL;
  try { canonical = new URL(appUrl); } catch { return new NextResponse('Invalid application URL', { status: 500 }); }

  const allowedHosts = new Set([
    canonical.host.toLowerCase(),
    ...(process.env.ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  ]);
  const incomingHost = (request.headers.get('host') ?? request.nextUrl.host).toLowerCase();
  if (!allowedHosts.has(incomingHost)) return new NextResponse('Invalid host', { status: 400 });

  const destination = new URL(request.nextUrl.pathname + request.nextUrl.search, canonical.origin);
  return NextResponse.redirect(destination, 308);
}

export function middleware(request: NextRequest) {
  const redirect = httpsRedirect(request);
  if (redirect) return redirect;

  const origin = request.headers.get('origin');
  const isApi = request.nextUrl.pathname.startsWith('/api/');
  const allowedCorsOrigins = new Set(configuredOriginList('ALLOWED_ORIGINS'));

  if (request.method === 'OPTIONS' && isApi) {
    let normalizedOrigin = '';
    try { if (origin && origin !== 'null') normalizedOrigin = new URL(origin).origin; } catch { /* rejected below */ }
    if (!normalizedOrigin || !allowedCorsOrigins.has(normalizedOrigin)) return new NextResponse(null, { status: 403 });
    const requestedMethod = request.headers.get('access-control-request-method')?.toUpperCase();
    if (!requestedMethod || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(requestedMethod)) {
      return new NextResponse(null, { status: 403 });
    }
    const requestedHeaders = request.headers.get('access-control-request-headers');
    const response = new NextResponse(null, { status: 204 });
    response.headers.set('Access-Control-Allow-Origin', normalizedOrigin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    const allowedHeaders = new Set(['content-type', 'x-csrf-token']);
    if (requestedHeaders?.split(',').map((header) => header.trim().toLowerCase()).some((header) => !allowedHeaders.has(header))) {
      return new NextResponse(null, { status: 403 });
    }
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    response.headers.set('Access-Control-Max-Age', '600');
    response.headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    let appOrigin = '';
    try { appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin; } catch { /* no credentialed CORS */ }
    if (normalizedOrigin === appOrigin) {
      response.headers.set('Access-Control-Allow-Credentials', 'true');
    }
    return response;
  }

  if (isApi && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !isTrustedOrigin(request.headers.get('origin'), request.headers.get('referer'))) {
    return new NextResponse(null, { status: 403 });
  }

  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  let normalizedOrigin = '';
  try { if (origin && origin !== 'null') normalizedOrigin = new URL(origin).origin; } catch { /* invalid Origin gets no CORS grant */ }
  if (normalizedOrigin && allowedCorsOrigins.has(normalizedOrigin) && isApi) {
    response.headers.set('Access-Control-Allow-Origin', normalizedOrigin);
    response.headers.set('Vary', 'Origin');
    let appOrigin = '';
    try { appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin; } catch { /* no credentialed CORS */ }
    if (normalizedOrigin === appOrigin) {
      response.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  }
  // Token-bearing screens must never be cached: the query string holds the verification /
  // password-reset / email-change token.
  const noStorePaths = [
    '/login', '/register', '/verify-email', '/forgot-password', '/reset-password',
    '/email-change/confirm', '/settings',
  ];
  if (isApi || noStorePaths.some((path) => request.nextUrl.pathname.startsWith(path))) {
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
