import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionCookieName } from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { getEnv } from '@/lib/env';
import { decryptClientTestSecret, getClientTestCookieName, readClientTestState, runConnectionTest } from '@/lib/oidc/client-test';
import { escapeHtml } from '@/lib/util/html';

export const dynamic = 'force-dynamic';

/**
 * Redirect URI target of the in-app connection test (D-26-06/D-26-08). The owner registers this
 * URI manually, so reaching it without a valid signed state cookie is not an error.
 */
export async function GET(request: Request): Promise<Response> {
  const cookieStore = await cookies();
  const url = new URL(request.url);
  const token = cookieStore.get(getSessionCookieName())?.value;
  const session = token ? await getSession(token) : null;
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(url.pathname)}`);

  const state = readClientTestState(cookieStore.get(getClientTestCookieName())?.value, session.id);
  const clearStateCookie = { name: getClientTestCookieName(), value: '', maxAge: 0 };

  if (!state) {
    return html(renderFailure('接続テストのセッションが失効しました。もう一度テストを実行してください。', null));
  }

  const backUrl = `/settings/applications/${encodeURIComponent(state.clientId)}`;
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    return html(renderFailure(`認証が完了しませんでした（${escapeHtml(error)}）`, description ? escapeHtml(description) : null, backUrl), clearStateCookie);
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || !returnedState || returnedState !== state.state) {
    return html(renderFailure('認証リクエストを検証できませんでした。もう一度テストを実行してください。', null, backUrl), clearStateCookie);
  }

  const issuer = getEnv().OIDC_ISSUER;
  if (!issuer) {
    return html(renderFailure('OIDC Provider が有効になっていません。', null, backUrl), clearStateCookie);
  }

  try {
    const result = await runConnectionTest({
      issuer,
      clientId: state.clientId,
      clientSecret: decryptClientTestSecret(state),
      redirectUri: state.redirectUri,
      code,
      codeVerifier: state.codeVerifier,
    });
    return html(renderSuccess(state.clientId, result.claims, result), clearStateCookie);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '接続テストに失敗しました。';
    return html(renderFailure(message, null, backUrl), clearStateCookie);
  }
}

function renderFailure(message: string, detail: string | null, backUrl?: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>接続テスト</title></head><body><main><h1>接続テスト</h1><p role="alert">${escapeHtml(message)}</p>${detail ? `<p>${detail}</p>` : ''}<p><a href="${escapeHtml(backUrl ?? '/settings/applications')}">アプリ設定へ戻る</a></p></main></body></html>`;
}

function renderSuccess(
  clientId: string,
  claims: Record<string, unknown>,
  result: { scopes: string[]; expiresIn: number | null; tokenType: string | null; idTokenIssued: boolean },
): string {
  const claimRows = Object.entries(claims)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(formatClaim(value))}</td></tr>`)
    .join('');
  const granted = result.scopes.length > 0 ? escapeHtml(result.scopes.join(' ')) : 'なし';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>接続テスト</title></head><body><main><h1>接続テスト成功</h1><p>リダイレクト URI と client secret が正しく、トークン交換とユーザー情報取得まで完了しました。</p><h2>トークン</h2><ul><li>付与された scope: ${granted}</li><li>アクセストークンの有効期限: ${result.expiresIn === null ? '不明' : `${escapeHtml(String(result.expiresIn))}秒`}</li><li>トークン種別: ${escapeHtml(result.tokenType ?? '不明')}</li><li>ID Token の発行: ${result.idTokenIssued ? 'あり' : 'なし'}</li></ul><h2>ユーザー情報（userinfo）</h2><table><tbody>${claimRows}</tbody></table><p>client_id: ${escapeHtml(clientId)}</p><p><a href="/settings/applications/${escapeHtml(encodeURIComponent(clientId))}">アプリ設定へ戻る</a></p></main></body></html>`;
}

function formatClaim(value: unknown): string {
  if (value === null || value === undefined) return '（なし）';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function html(body: string, clearStateCookie?: { name: string; value: string; maxAge: number }): Response {
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
  if (clearStateCookie) {
    response.headers.append(
      'Set-Cookie',
      `${clearStateCookie.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    );
  }
  return response;
}
