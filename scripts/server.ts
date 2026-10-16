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
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function interactionCsrf(uid: string, sessionId: string): string {
  return createHmac('sha256', getEnv().CSRF_SECRET).update(`oidc-consent\0${uid}\0${sessionId}`).digest('base64url');
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

async function interaction(req: IncomingMessage, res: ServerResponse, provider: OidcProvider): Promise<void> {
  try {
    const details = await provider.interactionDetails(req, res);
    const uid = typeof details.uid === 'string' ? details.uid : '';
    if (!uid) return send(res, 400, '<!doctype html><title>認証エラー</title><p>認証リクエストを確認できませんでした。</p>');
    const user = await currentOidcAppSession(req);
    const promptValue = typeof details.params?.prompt === 'string' ? details.params.prompt : '';
    const prompts = new Set(promptValue.split(/\s+/u).filter(Boolean));
    if (!user && prompts.has('none')) {
      await provider.interactionFinished(req, res, { error: 'login_required' }, { mergeWithLastSubmission: true });
      return;
    }
    if (!user) {
      const blocked = req.method === 'GET' ? await blockedOidcAccount(req) : null;
      if (blocked) {
        await recordSecurityEvent('oidc_account_blocked', blocked.userId, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { status: blocked.status, endpoint: 'interaction' });
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
    const scopes: string[] = typeof requestedScope === 'string' ? [...new Set(requestedScope.split(/\s+/u).filter(Boolean))] : [];
    const clientResult = await getPool().query<{
      name: string; operator: string; allowed_scopes: string[]; active: boolean;
    }>(
      `SELECT name, operator, allowed_scopes, active FROM oauth_clients
       WHERE client_id = $1 AND active = true AND revoked_at IS NULL`, [clientId],
    );
    const client = clientResult.rows[0];
    if (!client || !scopes.includes('openid') || !isScopeSubset(scopes, client.allowed_scopes)) {
      await recordSecurityEvent('oidc_authorize_denied', user.id, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { reason: 'client_or_scope' });
      return send(res, 400, '<!doctype html><title>認証エラー</title><p>要求されたサービスまたは権限を確認できません。</p>');
    }

    const promptName = details.prompt?.name;
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const issuerOrigin = new URL(getEnv().OIDC_ISSUER!).origin;
      if (origin !== issuerOrigin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        return send(res, 403, '<!doctype html><title>拒否されました</title><p>送信元を確認できません。</p>');
      }
      const form = await readForm(req);
      const expected = interactionCsrf(uid, user.sessionId);
      if (!safeEqual(form.get('csrf') ?? '', expected)) {
        return send(res, 403, '<!doctype html><title>拒否されました</title><p>フォームの有効期限が切れました。最初からやり直してください。</p>');
      }
      if (promptName !== 'consent') return send(res, 400, '<!doctype html><title>認証エラー</title><p>操作を完了できません。</p>');
      if (form.get('decision') !== 'allow') {
        await recordSecurityEvent('oidc_consent_denied', user.id, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { clientId, scopes });
        await provider.interactionFinished(req, res, { error: 'access_denied' }, { mergeWithLastSubmission: true });
        return;
      }
      const subject = await ensureSubject(user.id, clientId);
      if (!subject) {
        await recordSecurityEvent('oidc_authorize_denied', user.id, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { reason: 'subject_issue_failed' });
        return send(res, 400, '<!doctype html><title>認証エラー</title><p>認証リクエストを完了できません。最初からやり直してください。</p>');
      }
      const priorGrantId = typeof details.grantId === 'string' ? details.grantId
        : typeof details.session?.grantId === 'string' ? details.session.grantId : undefined;
      const existingGrant = priorGrantId ? await provider.Grant.find(priorGrantId) : undefined;
      if (existingGrant && existingGrant.accountId !== subject) {
        await recordSecurityEvent('oidc_authorize_denied', user.id, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { reason: 'grant_account_mismatch', clientId });
        return send(res, 400, '<!doctype html><title>認証エラー</title><p>認証リクエストを完了できません。最初からやり直してください。</p>');
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
      await recordSecurityEvent('oidc_consent_granted', user.id, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { clientId, scopes: grantedScopes, replacedGrant: Boolean(priorGrantId) });
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
      return;
    }

    const maxAge = details.params?.max_age === undefined ? null : Number(details.params.max_age);
    const interactionStartedAt = typeof details.iat === 'number' ? details.iat * 1000 : Date.now();
    const authenticatedDuringInteraction = user.createdAt.getTime() >= interactionStartedAt;
    const maxAgeSatisfied = maxAge === null || (authenticatedDuringInteraction
      || (Number.isFinite(maxAge) && maxAge > 0 && Date.now() - user.createdAt.getTime() <= maxAge * 1000));
    if (promptName === 'login' && ((prompts.has('login') && !authenticatedDuringInteraction) || !maxAgeSatisfied)) {
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
        await recordSecurityEvent('oidc_authorize_denied', user.id, req.socket.remoteAddress ?? '', req.headers['user-agent'] ?? '', { reason: 'subject_issue_failed' });
        return send(res, 400, '<!doctype html><title>認証エラー</title><p>認証リクエストを完了できません。最初からやり直してください。</p>');
      }
      await provider.interactionFinished(req, res, {
        login: { accountId: subject, ts: Math.floor(user.createdAt.getTime() / 1000), acr: 'urn:oauth:auth:password' },
      }, { mergeWithLastSubmission: true });
      return;
    }
    if (promptName === 'consent' && prompts.has('none')) {
      await provider.interactionFinished(req, res, { error: 'consent_required' }, { mergeWithLastSubmission: true });
      return;
    }
    if (promptName !== 'consent') return send(res, 400, '<!doctype html><title>認証エラー</title><p>この認証方式には対応していません。</p>');

    const claimLabels: Record<string, string> = {
      openid: 'このサービスだけが使用できる不透明なID (sub)',
      profile: '表示名 (name)・ユーザー名 (preferred_username)・HTTPSのプロフィール画像 (picture)',
      email: '確認済みメールアドレス (email)・確認済みである与否 (email_verified)',
    };
    const scopeList = scopes.map((scope) => `<li><strong>${escapeHtml(scope)}</strong>: ${escapeHtml(claimLabels[scope] ?? '未対応の権限')}</li>`).join('');
    const csrf = interactionCsrf(uid, user.sessionId);
    const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>サービス連携の確認</title><main><h1>サービス連携の確認</h1><p><strong>${escapeHtml(client.name)}</strong>（運営者: ${escapeHtml(client.operator || client.name)}）がアカウント情報へのアクセスを求めています。</p><p>ログイン中: ${escapeHtml(user.username)}</p><h2>共有される情報</h2><ul>${scopeList}</ul><p>許可しない場合、サービスには情報を共有しません。許可はアカウント設定から後で取り消せます。</p><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit" name="decision" value="allow">許可する</button> <button type="submit" name="decision" value="deny">許可しない</button></form></main></html>`;
    send(res, 200, html);
  } catch (cause) {
    logger.error('oidc interaction failed', {
      cause: cause instanceof Error ? cause.message : String(cause),
      detail: (cause as { error_description?: unknown })?.error_description ?? null,
      stack: cause instanceof Error ? (cause.stack ?? '').slice(0, 600) : '',
    });
    if (!res.headersSent) send(res, 400, '<!doctype html><title>認証エラー</title><p>認証リクエストを完了できません。最初からやり直してください。</p>');
    else res.end();
  }
}

function validOidcRequestOrigin(req: IncomingMessage): boolean {
  const env = getEnv();
  if (!env.OIDC_ISSUER || req.headers.host?.toLowerCase() !== new URL(env.OIDC_ISSUER).host.toLowerCase()) return false;
  if (process.env.NODE_ENV !== 'production' || req.socket instanceof TLSSocket) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const values = typeof forwarded === 'string' ? forwarded.split(',').map((value) => value.trim()) : [];
  const proxyIndex = Math.max(0, values.length - env.TRUSTED_PROXY_HOPS - 1);
  return env.TRUSTED_PROXY_HOPS > 0 && values[proxyIndex] === 'https';
}

async function exactAuthorizationRequest(req: IncomingMessage): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const env = getEnv();
  const url = new URL(req.url ?? '/', env.OIDC_ISSUER);
  const one = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? values[0] ?? null : null;
  };
  const clientId = one('client_id');
  const redirectUri = one('redirect_uri');
  const responseType = one('response_type');
  const scope = one('scope');
  const challenge = one('code_challenge');
  const method = one('code_challenge_method');
  if (!clientId || !redirectUri || responseType !== 'code' || !scope?.split(/\s+/u).includes('openid')
    || !one('state') || !one('nonce') || !challenge || method !== 'S256'
    || ['resource', 'authorization_details', 'request', 'request_uri'].some((key) => url.searchParams.has(key))) return false;
  const requestedScopes = [...new Set(scope.split(/\s+/u).filter(Boolean))];
  if (requestedScopes.length !== scope.split(/\s+/u).filter(Boolean).length) return false;
  const client = await getPool().query<{ redirect_uris: string[]; allowed_scopes: string[] }>(
    `SELECT redirect_uris, allowed_scopes FROM oauth_clients
     WHERE client_id = $1 AND active = true AND revoked_at IS NULL`, [clientId],
  );
  const row = client.rows[0];
  return Boolean(row && row.redirect_uris.includes(redirectUri)
    && isScopeSubset(requestedScopes, row.allowed_scopes));
}

export function createOidcHandler(provider: OidcProvider): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const oidcCallback = provider.callback();
  return async (req, res) => {
    const pathname = parse(req.url ?? '/').pathname ?? '';
    const oidcPath = pathname.startsWith('/oauth2/') || pathname === '/.well-known/openid-configuration';
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
        await recordSecurityEvent('rate_limited', null, ip, req.headers['user-agent'] ?? '', { scope: 'oidc_interaction' });
        res.statusCode = 429;
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limited.resetAt - Date.now()) / 1000))));
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
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const env = getEnv();
      const headers = nodeHeaders(req);
      const ip = getRequestClientIp({ headers, ip: req.socket.remoteAddress });
      const kind = pathname.endsWith('/authorize') ? 'authorize'
        : pathname.endsWith('/token') ? 'token'
          : pathname.endsWith('/userinfo') ? 'userinfo'
            : pathname.endsWith('/revoke') ? 'revoke' : null;
      if (kind) {
        const rate = RATE_LIMITS.oidc[kind];
        const basic = req.headers.authorization?.startsWith('Basic ')
          ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':', 1)[0]
          : '';
        const bearer = kind === 'userinfo' && req.headers.authorization?.startsWith('Bearer ')
          ? hashIp(req.headers.authorization.slice(7), env.IP_HASH_PEPPER)
          : '';
        const result = await rateLimiter.check(
          `oidc:${kind}:${basic || bearer || 'public'}:${hashIp(ip, env.IP_HASH_PEPPER)}`,
          rate.window,
          rate.limit,
        );
        if (!result.allowed) {
          await recordSecurityEvent('rate_limited', null, ip, req.headers['user-agent'] ?? '', { scope: `oidc_${kind}` });
          res.statusCode = 429;
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
          res.end('Too Many Requests');
          return true;
        }
      }
      if (pathname === '/oauth2/authorize' && !await exactAuthorizationRequest(req)) {
        await recordSecurityEvent('oidc_authorize_denied', null, ip, req.headers['user-agent'] ?? '', { reason: 'invalid_authorization_request' });
        res.statusCode = 400;
        res.end('Invalid authorization request');
        return true;
      }
      oidcCallback(req, res);
    } catch {
      if (!res.headersSent) { res.statusCode = 503; res.end('OIDC temporarily unavailable'); }
      else res.end();
    }
    return true;
  };
}

export async function startServer(options: { dev: boolean; port: number; hostname: string }): Promise<{ server: Server; provider: OidcProvider | null }> {
  const { dev, port, hostname } = options;
  const { default: next } = await import('next');
  const app = next({ dev, hostname, port });
  await app.prepare();
  const handleNext = app.getRequestHandler();
  const handleUpgrade = app.getUpgradeHandler();
  const provider = await getOidcProvider();
  const handleOidc = provider ? createOidcHandler(provider) : null;

  const server = createServer(async (req, res) => {
    if (handleOidc && await handleOidc(req, res)) return;
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
  main().catch(() => {
    process.stderr.write('Application server failed to start. Check the environment configuration.\n');
    process.exitCode = 1;
  });
}
