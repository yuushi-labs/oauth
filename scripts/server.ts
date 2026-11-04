// 必ず先頭で読み込むこと: globalThis.AsyncLocalStorage を Next の読み込み前に設定する。
import './next-env';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { parse } from 'node:url';
import { getEnv } from '@/lib/env';
import { getPool } from '@/lib/db/client';
import { getOidcProvider } from '@/lib/oidc/provider';
import { getRequestClientIp } from '@/lib/auth/session';
import { hashIp } from '@/lib/util/ip';
import { rateLimiter } from '@/lib/auth/rate-limit';
import { RATE_LIMITS } from '@/config/rate-limits';
import { recordSecurityEvent } from '@/lib/auth/security-events';
import { logger } from '@/lib/util/logger';
import { currentOidcAppSession, blockedOidcAccount, type OidcAppSession } from '@/lib/oidc/session';
import { isScopeSubset } from '@/lib/oidc/scopes';
import { ensureSubject } from '@/lib/oidc/subjects';

type AuthenticatedUser = OidcAppSession;
type OidcProvider = NonNullable<Awaited<ReturnType<typeof getOidcProvider>>>;

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // 'unsafe-inline' for style-src only: these pages render their own <style> block so they
  // can honour the OS colour scheme (BUG-5). script-src stays absent, i.e. 'none' by
  // default-src, so no script can ever run on these pages.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.end(body);
}

/**
 * Minimal theme support for the self-rendered OIDC pages (BUG-5). These pages bypass the
 * React tree, so they never see globals.css or ThemeProvider. The block follows the OS
 * preference, which is enough to satisfy the §64 "Dark" requirement for the consent flow.
 *
 * Contrast (WCAG AA) — light: #0f172a on #ffffff = 17.9:1, #1d4ed8 on #ffffff = 8.6:1,
 * white on #1d4ed8 = 8.6:1. dark: #e5e7eb on #111827 = 14.3:1, #93c5fd on #111827 = 8.4:1.
 */
const OIDC_PAGE_STYLE = `<style>
:root{color-scheme:light dark;--bg:#f1f5f9;--card:#ffffff;--fg:#0f172a;--muted:#475569;--border:#cbd5e1;--accent:#1d4ed8;--accent-fg:#ffffff}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif;line-height:1.7;-webkit-text-size-adjust:100%}
main{max-width:640px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:0 1px 2px rgba(15,23,42,.06)}
h1{font-size:20px;line-height:1.4;margin:0 0 12px}
h2{font-size:15px;margin:24px 0 8px;color:var(--muted);letter-spacing:.02em}
p{margin:0 0 12px}
ul{margin:0;padding-left:20px}
li{margin:4px 0}
strong{font-weight:600}
a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
form{margin-top:20px;display:flex;flex-wrap:wrap;gap:10px}
button{font:inherit;font-weight:600;padding:11px 20px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
button:hover{opacity:.9}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button[name="decision"][value="deny"]{background:var(--card);color:var(--fg);border-color:var(--border)}
@media (prefers-color-scheme:dark){
:root{--bg:#0b0f19;--card:#111827;--fg:#e5e7eb;--muted:#9ca3af;--border:#374151;--accent:#1d4ed8;--accent-fg:#ffffff}
a{color:#93c5fd}
button:focus-visible{outline-color:#93c5fd}
}
</style>`;

/** Wraps a body fragment into a themed HTML document. */
function themedPage(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${OIDC_PAGE_STYLE}</head><body><main>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function interactionCsrf(uid: string, sessionId: string): string {
  return createHmac('sha256', getEnv().CSRF_SECRET)
    .update(`oidc-consent\0${uid}\0${sessionId}`)
    .digest('base64url');
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) throw new Error('form too large');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (typeof raw === 'string') headers.set(key, raw);
    else if (Array.isArray(raw)) headers.set(key, raw.join(', '));
  }
  return headers;
}

async function interaction(
  req: IncomingMessage,
  res: ServerResponse,
  provider: OidcProvider,
): Promise<void> {
  try {
    const details = await provider.interactionDetails(req, res);
    const uid = typeof details.uid === 'string' ? details.uid : '';
    if (!uid)
      return send(
        res,
        400,
        themedPage('認証エラー', '<p>認証リクエストを確認できませんでした。</p>'),
      );
    const user = await currentOidcAppSession(req);
    const promptValue = typeof details.params?.prompt === 'string' ? details.params.prompt : '';
    const prompts = new Set(promptValue.split(/\s+/u).filter(Boolean));
    if (!user && prompts.has('none')) {
      await provider.interactionFinished(
        req,
        res,
        { error: 'login_required' },
        { mergeWithLastSubmission: true },
      );
      return;
    }
    if (!user) {
      const blocked = req.method === 'GET' ? await blockedOidcAccount(req) : null;
      if (blocked) {
        await recordSecurityEvent(
          'oidc_account_blocked',
          blocked.userId,
          req.socket.remoteAddress ?? '',
          req.headers['user-agent'] ?? '',
          { status: blocked.status, endpoint: 'interaction' },
        );
      }
      const returnTo = `${parse(req.url ?? '/').pathname ?? '/'}${parse(req.url ?? '/').search ?? ''}`;
      res.statusCode = 303;
      res.setHeader('Location', `/login?returnTo=${encodeURIComponent(returnTo)}`);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.end();
      return;
    }

    const requestedClientId: unknown = details.params?.client_id;
    const requestedScope: unknown = details.params?.scope;
    const clientId = typeof requestedClientId === 'string' ? requestedClientId : '';
    const scopes: string[] =
      typeof requestedScope === 'string'
        ? [...new Set(requestedScope.split(/\s+/u).filter(Boolean))]
        : [];
    const clientResult = await getPool().query<{
      name: string;
      operator: string;
      allowed_scopes: string[];
      active: boolean;
      owner_username: string | null;
      registered_at: Date;
    }>(
      `SELECT c.name, c.operator, c.allowed_scopes, c.active, c.created_at AS "registered_at",
              u.username AS "owner_username"
       FROM oauth_clients c
       LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE c.client_id = $1 AND c.active = true AND c.revoked_at IS NULL`,
      [clientId],
    );
    const client = clientResult.rows[0];
    if (!client || !scopes.includes('openid') || !isScopeSubset(scopes, client.allowed_scopes)) {
      await recordSecurityEvent(
        'oidc_authorize_denied',
        user.id,
        req.socket.remoteAddress ?? '',
        req.headers['user-agent'] ?? '',
        { reason: 'client_or_scope' },
      );
      return send(
        res,
        400,
        themedPage('認証エラー', '<p>要求されたサービスまたは権限を確認できません。</p>'),
      );
    }

    const promptName = details.prompt?.name;
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const issuerOrigin = new URL(getEnv().OIDC_ISSUER!).origin;
      if (
        origin !== issuerOrigin ||
        req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded'
      ) {
        return send(res, 403, themedPage('拒否されました', '<p>送信元を確認できません。</p>'));
      }
      const form = await readForm(req);
      const expected = interactionCsrf(uid, user.sessionId);
      if (!safeEqual(form.get('csrf') ?? '', expected)) {
        return send(
          res,
          403,
          themedPage(
            '拒否されました',
            '<p>フォームの有効期限が切れました。最初からやり直してください。</p>',
          ),
        );
      }
      if (promptName !== 'consent')
        return send(res, 400, themedPage('認証エラー', '<p>操作を完了できません。</p>'));
      if (form.get('decision') !== 'allow') {
        await recordSecurityEvent(
          'oidc_consent_denied',
          user.id,
          req.socket.remoteAddress ?? '',
          req.headers['user-agent'] ?? '',
          { clientId, scopes },
        );
        await provider.interactionFinished(
          req,
          res,
          { error: 'access_denied' },
          { mergeWithLastSubmission: true },
        );
        return;
      }
      const subject = await ensureSubject(user.id, clientId);
      if (!subject) {
        await recordSecurityEvent(
          'oidc_authorize_denied',
          user.id,
          req.socket.remoteAddress ?? '',
          req.headers['user-agent'] ?? '',
          { reason: 'subject_issue_failed' },
        );
        return send(
          res,
          400,
          themedPage(
            '認証エラー',
            '<p>認証リクエストを完了できません。最初からやり直してください。</p>',
          ),
        );
      }
      const priorGrantId =
        typeof details.grantId === 'string'
          ? details.grantId
          : typeof details.session?.grantId === 'string'
            ? details.session.grantId
            : undefined;
      const existingGrant = priorGrantId ? await provider.Grant.find(priorGrantId) : undefined;
      if (existingGrant && existingGrant.accountId !== subject) {
        await recordSecurityEvent(
          'oidc_authorize_denied',
          user.id,
          req.socket.remoteAddress ?? '',
          req.headers['user-agent'] ?? '',
          { reason: 'grant_account_mismatch', clientId },
        );
        return send(
          res,
          400,
          themedPage(
            '認証エラー',
            '<p>認証リクエストを完了できません。最初からやり直してください。</p>',
          ),
        );
      }
      const grant = existingGrant ?? new provider.Grant({ accountId: subject, clientId });
      grant.addOIDCScope(scopes.join(' '));
      const grantId = await grant.save();
      const grantedScopes = [...new Set(grant.getOIDCScope().split(/\s+/u).filter(Boolean))];
      await getPool().query(
        `INSERT INTO oidc_user_grants (id, user_id, client_id, scopes, updated_at, last_used_at)
         VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (user_id, client_id) DO UPDATE SET
           id = EXCLUDED.id, scopes = EXCLUDED.scopes, updated_at = now(), last_used_at = now(), revoked_at = NULL`,
        [grantId, user.id, clientId, grantedScopes],
      );
      await recordSecurityEvent(
        'oidc_consent_granted',
        user.id,
        req.socket.remoteAddress ?? '',
        req.headers['user-agent'] ?? '',
        { clientId, scopes: grantedScopes, replacedGrant: Boolean(priorGrantId) },
      );
      await provider.interactionFinished(
        req,
        res,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }

    const maxAge = details.params?.max_age === undefined ? null : Number(details.params.max_age);
    const interactionStartedAt = typeof details.iat === 'number' ? details.iat * 1000 : Date.now();
    const authenticatedDuringInteraction = user.createdAt.getTime() >= interactionStartedAt;
    const maxAgeSatisfied =
      maxAge === null ||
      authenticatedDuringInteraction ||
      (Number.isFinite(maxAge) &&
        maxAge > 0 &&
        Date.now() - user.createdAt.getTime() <= maxAge * 1000);
    if (
      promptName === 'login' &&
      ((prompts.has('login') && !authenticatedDuringInteraction) || !maxAgeSatisfied)
    ) {
      const returnTo = `${parse(req.url ?? '/').pathname ?? '/'}${parse(req.url ?? '/').search ?? ''}`;
      res.statusCode = 303;
      res.setHeader('Location', `/login?returnTo=${encodeURIComponent(returnTo)}`);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.end();
      return;
    }
    if (promptName === 'login') {
      const subject = await ensureSubject(user.id, clientId);
      if (!subject) {
        await recordSecurityEvent(
          'oidc_authorize_denied',
          user.id,
          req.socket.remoteAddress ?? '',
          req.headers['user-agent'] ?? '',
          { reason: 'subject_issue_failed' },
        );
        return send(
          res,
          400,
          themedPage(
            '認証エラー',
            '<p>認証リクエストを完了できません。最初からやり直してください。</p>',
          ),
        );
      }
      await provider.interactionFinished(
        req,
        res,
        {
          login: {
            accountId: subject,
            ts: Math.floor(user.createdAt.getTime() / 1000),
            acr: 'urn:oauth:auth:password',
          },
        },
        { mergeWithLastSubmission: true },
      );
      return;
    }
    if (promptName === 'consent' && prompts.has('none')) {
      await provider.interactionFinished(
        req,
        res,
        { error: 'consent_required' },
        { mergeWithLastSubmission: true },
      );
      return;
    }
    if (promptName !== 'consent')
      return send(res, 400, themedPage('認証エラー', '<p>この認証方式には対応していません。</p>'));

    const claimLabels: Record<string, string> = {
      openid: 'このサービスだけが使用できる不透明なID (sub)',
      profile: '表示名 (name)・ユーザー名 (preferred_username)・HTTPSのプロフィール画像 (picture)',
      email: 'メールアドレス (email)。メール所有の確認は行っていないため email_verified は常に false',
    };
    const scopeList = scopes
      .map(
        (scope) =>
          `<li><strong>${escapeHtml(scope)}</strong>: ${escapeHtml(claimLabels[scope] ?? '未対応の権限')}</li>`,
      )
      .join('');
    const csrf = interactionCsrf(uid, user.sessionId);
    // Self-service clients are registered by their own users, so the registrant is always disclosed.
    const registrant = client.owner_username
      ? `このアプリはユーザー「${escapeHtml(client.owner_username)}」が ${escapeHtml(client.registered_at.toISOString().slice(0, 10))} に登録したものです`
      : 'このアプリは運営者がコマンドラインで登録したものです';
    const registrantNotice = client.owner_username
      ? '運営者名を自由に設定できるため、必ず登録者が意図した相手か確認してください。'
      : '運営者が設定したアプリです。';
    const consentBody = `<h1>サービス連携の確認</h1><p><strong>${escapeHtml(client.name)}</strong>（運営者: ${escapeHtml(client.operator || client.name)}）がアカウント情報へのアクセスを求めています。</p><p>${registrant}。</p><p>${registrantNotice}</p><p>ログイン中: ${escapeHtml(user.username)}</p><h2>共有される情報</h2><ul>${scopeList}</ul><p>許可しない場合、サービスには情報を共有しません。許可はアカウント設定から後で取り消せます。</p><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" name="decision" value="allow">許可する</button> <button type="submit" name="decision" value="deny">許可しない</button></form>`;
    send(res, 200, themedPage('サービス連携の確認', consentBody));
  } catch (cause) {
    logger.error('oidc interaction failed', {
      cause: cause instanceof Error ? cause.message : String(cause),
      detail: (cause as { error_description?: unknown })?.error_description ?? null,
      stack: cause instanceof Error ? (cause.stack ?? '').slice(0, 600) : '',
    });
    if (!res.headersSent)
      send(
        res,
        400,
        themedPage(
          '認証エラー',
          '<p>認証リクエストを完了できません。最初からやり直してください。</p>',
        ),
      );
    else res.end();
  }
}

function validOidcRequestOrigin(req: IncomingMessage): boolean {
  const env = getEnv();
  if (
    !env.OIDC_ISSUER ||
    req.headers.host?.toLowerCase() !== new URL(env.OIDC_ISSUER).host.toLowerCase()
  )
    return false;
  if (process.env.NODE_ENV !== 'production' || req.socket instanceof TLSSocket) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const values =
    typeof forwarded === 'string' ? forwarded.split(',').map((value) => value.trim()) : [];
  const proxyIndex = Math.max(0, values.length - env.TRUSTED_PROXY_HOPS - 1);
  return env.TRUSTED_PROXY_HOPS > 0 && values[proxyIndex] === 'https';
}

async function exactAuthorizationRequest(req: IncomingMessage): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const env = getEnv();
  const url = new URL(req.url ?? '/', env.OIDC_ISSUER);
  const one = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? (values[0] ?? null) : null;
  };
  const clientId = one('client_id');
  const redirectUri = one('redirect_uri');
  const responseType = one('response_type');
  const scope = one('scope');
  const challenge = one('code_challenge');
  const method = one('code_challenge_method');
  if (
    !clientId ||
    !redirectUri ||
    responseType !== 'code' ||
    !scope?.split(/\s+/u).includes('openid') ||
    !one('state') ||
    !one('nonce') ||
    !challenge ||
    method !== 'S256' ||
    ['resource', 'authorization_details', 'request', 'request_uri'].some((key) =>
      url.searchParams.has(key),
    )
  )
    return false;
  const requestedScopes = [...new Set(scope.split(/\s+/u).filter(Boolean))];
  if (requestedScopes.length !== scope.split(/\s+/u).filter(Boolean).length) return false;
  const client = await getPool().query<{ redirect_uris: string[]; allowed_scopes: string[] }>(
    `SELECT redirect_uris, allowed_scopes FROM oauth_clients
     WHERE client_id = $1 AND active = true AND revoked_at IS NULL`,
    [clientId],
  );
  const row = client.rows[0];
  return Boolean(
    row &&
    row.redirect_uris.includes(redirectUri) &&
    isScopeSubset(requestedScopes, row.allowed_scopes),
  );
}

export function createOidcHandler(
  provider: OidcProvider,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const oidcCallback = provider.callback();
  return async (req, res) => {
    const pathname = parse(req.url ?? '/').pathname ?? '';
    const oidcPath =
      pathname.startsWith('/oauth2/') || pathname === '/.well-known/openid-configuration';
    if (!oidcPath && !pathname.startsWith('/oauth2/interaction/')) return false;
    if (oidcPath) {
      if (!validOidcRequestOrigin(req)) {
        res.statusCode = 400;
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.end('Invalid OIDC request origin or HTTPS transport');
        return true;
      }
      if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      }
    }
    if (pathname.startsWith('/oauth2/interaction/')) {
      if (!validOidcRequestOrigin(req)) {
        res.statusCode = 400;
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.end('Invalid OIDC request origin or HTTPS transport');
        return true;
      }
      const ip = getRequestClientIp({ headers: nodeHeaders(req), ip: req.socket.remoteAddress });
      const interactionLimit = RATE_LIMITS.oidc.interaction;
      const limited = await rateLimiter.check(
        `oidc:interaction:${hashIp(ip, getEnv().IP_HASH_PEPPER)}`,
        interactionLimit.window,
        interactionLimit.limit,
      );
      if (!limited.allowed) {
        await recordSecurityEvent('rate_limited', null, ip, req.headers['user-agent'] ?? '', {
          scope: 'oidc_interaction',
        });
        res.statusCode = 429;
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil((limited.resetAt - Date.now()) / 1000))),
        );
        res.end('Too Many Requests');
        return true;
      }
      await interaction(req, res, provider);
      return true;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const env = getEnv();
      const headers = nodeHeaders(req);
      const ip = getRequestClientIp({ headers, ip: req.socket.remoteAddress });
      const kind = pathname.endsWith('/authorize')
        ? 'authorize'
        : pathname.endsWith('/token')
          ? 'token'
          : pathname.endsWith('/userinfo')
            ? 'userinfo'
            : pathname.endsWith('/revoke')
              ? 'revoke'
              : null;
      if (kind) {
        const rate = RATE_LIMITS.oidc[kind];
        const basic = req.headers.authorization?.startsWith('Basic ')
          ? Buffer.from(req.headers.authorization.slice(6), 'base64')
              .toString('utf8')
              .split(':', 1)[0]
          : '';
        const bearer =
          kind === 'userinfo' && req.headers.authorization?.startsWith('Bearer ')
            ? hashIp(req.headers.authorization.slice(7), env.IP_HASH_PEPPER)
            : '';
        const result = await rateLimiter.check(
          `oidc:${kind}:${basic || bearer || 'public'}:${hashIp(ip, env.IP_HASH_PEPPER)}`,
          rate.window,
          rate.limit,
        );
        if (!result.allowed) {
          await recordSecurityEvent('rate_limited', null, ip, req.headers['user-agent'] ?? '', {
            scope: `oidc_${kind}`,
          });
          res.statusCode = 429;
          res.setHeader(
            'Retry-After',
            String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
          );
          res.end('Too Many Requests');
          return true;
        }
      }
      if (pathname === '/oauth2/authorize' && !(await exactAuthorizationRequest(req))) {
        await recordSecurityEvent(
          'oidc_authorize_denied',
          null,
          ip,
          req.headers['user-agent'] ?? '',
          { reason: 'invalid_authorization_request' },
        );
        res.statusCode = 400;
        res.end('Invalid authorization request');
        return true;
      }
      oidcCallback(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 503;
        res.end('OIDC temporarily unavailable');
      } else res.end();
    }
    return true;
  };
}

export async function startServer(options: {
  dev: boolean;
  port: number;
  hostname: string;
}): Promise<{ server: Server; provider: OidcProvider | null }> {
  const { dev, port, hostname } = options;
  const { default: next } = await import('next');
  const app = next({ dev, hostname, port });
  await app.prepare();
  // migration 未適用のまま起動すると、初回リクエストが `relation "xxx" does not exist` の
  // 500 になる。原因が分かりにくいので、`.env` を読み終えたここで不足テーブルを検出し
  // fail fast する。NODE_ENV=test は自前で schema を用意するため対象外。
  if (process.env.NODE_ENV !== 'test') {
    const { assertSchemaReady } = await import('@/lib/db/schema-readiness');
    await assertSchemaReady();
    // CAPTCHA は site key と secret の両方がそろって初めて機能する。片方だけだと
    // 「設定済みに見えて実は突破不能」になるため、本番は起動時に検出して fail fast する（BUG-22）。
    const { assertCaptchaConfigConsistent } = await import('@/lib/auth/captcha-config');
    assertCaptchaConfigConsistent();
  }
  const handleNext = app.getRequestHandler();
  const handleUpgrade = app.getUpgradeHandler();
  const provider = await getOidcProvider();
  const handleOidc = provider ? createOidcHandler(provider) : null;

  const server = createServer(async (req, res) => {
    if (handleOidc && (await handleOidc(req, res))) return;
    await handleNext(req, res);
  });
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => resolve());
  });
  return { server, provider: provider ?? null };
}

async function main(): Promise<void> {
  const dev = process.argv[2] === 'dev';
  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOSTNAME ?? '0.0.0.0';
  const { server } = await startServer({ dev, port, hostname });
  process.stdout.write(`> Ready on http://${hostname}:${port}\n`);
  server.unref();
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
    }
    process.stderr.write(
      'Application server failed to start. Check the environment configuration.\n',
    );
    // Next の dev は watcher が event loop を掴み続けるため、exitCode だけでは終了しない。
    process.exit(1);
  });
}
