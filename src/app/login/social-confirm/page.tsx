import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { deriveCsrfToken } from '@/lib/auth/pipeline';
import {
  getAnonCookieName,
  getAnonCsrfSecret,
  getSessionCookieName,
  getSocialClaimCookieName,
} from '@/lib/auth/cookie';
import { getSession } from '@/lib/auth/session';
import { peekSocialClaim } from '@/lib/auth/oauth/social-claim';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';
import { SocialConfirmForm } from '@/components/auth/social-confirm-form';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

/**
 * ソーシャル連携の確認画面（Phase 4-B / D-32-01）。
 *
 * callback で「紐付きが無い」と判定されたとき、ここに来る。利用者はここで
 * 「この email でアカウントを作る」または「email + password でログインして連携」を選ぶ。
 *
 * - claim の token は **Cookie で運んでいる**ので、この URL には何も載らない（D-32-05）。
 * - claim が無い / 期限切れ / 消費済みなら `/login` へ戻す（画面から操作させない）。
 * - **CSRF トークンは callback が書き込んだ anon Cookie から読んで渡す**（BUG-15）。
 *   クライアントが後から `/api/auth/csrf` を叩くと、Cookie 保存のタイミングに
 *   依存してトークンと Cookie が食い違い 403 になる。callback で両方用意し、
 *   ここでは「読むだけ」にする（Server Component は Cookie を変更できない）。
 * - **この画面では何も実行しない**。新規登録も連携も完了 API が行う。
 */
export default async function SocialConfirmPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(getSocialClaimCookieName())?.value ?? null;
  if (!token) redirect('/login');

  const claim = await findClaim(token);
  if (!claim) redirect('/login');

  const providerLabel =
    OAUTH_PROVIDER_REGISTRY.find((p) => p.id === claim.provider)?.label ?? claim.provider;

  // 「このメールで作る」を出せるのは、検証済みかつ既存アカウントが無いときだけ。
  // 未検証 email で自動登録すると乗っ取りの入口になる（D-32-13）。
  const canSignup = claim.emailVerified && Boolean(claim.providerEmail) && claim.emailOwnerId === null;
  const hasExistingAccount = claim.emailOwnerId !== null;

  const csrfToken = await resolveCsrfToken(cookieStore);
  // CSRF の材料が無いなら壊れた状態なので、描き切らず `/login` へ戻す
  if (!csrfToken) redirect('/login');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-bold">
          {m('oauth.confirm.title', { provider: providerLabel })}
        </h1>
        <p className="mt-2 text-sm text-muted-fg">{m('oauth.confirm.intro')}</p>
      </header>

      <SocialConfirmForm
        providerLabel={providerLabel}
        providerEmail={claim.providerEmail}
        canSignup={canSignup}
        hasExistingAccount={hasExistingAccount}
        csrfToken={csrfToken}
      />
    </main>
  );
}

/** provider を引かず token だけで claim を探す（画面と完了 API の判定を揃える）。 */
async function findClaim(token: string) {
  for (const provider of OAUTH_PROVIDER_REGISTRY) {
    const found = await peekSocialClaim(token, provider.id);
    if (found) return found;
  }
  return null;
}

/**
 * CSRF トークンをサーバー側で確定する（BUG-15）。
 *
 * - セッションがあれば session 由来のトークン
 * - 無ければ anon Cookie の secret。**callback がこの Cookie を書き込んだ**ので、
 *   ここで同じ値をそのままクライアントへ渡せば必ず一致する。
 *
 * どちらも無い場合は描画を諦める。Server Component から Cookie は書けないので、
 * この場合は `/login` からやり直してもらうのが正しい（黙って壊れた token を渡さない）。
 */
async function resolveCsrfToken(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): Promise<string | null> {
  const sessionToken = cookieStore.get(getSessionCookieName())?.value;
  if (sessionToken) {
    const session = await getSession(sessionToken);
    if (session) return deriveCsrfToken(session);
  }

  return getAnonCsrfSecret(cookieStore.get(getAnonCookieName())?.value ?? null);
}