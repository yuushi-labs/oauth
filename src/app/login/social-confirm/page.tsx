import { redirect } from 'next/navigation';
import { peekSocialClaim } from '@/lib/auth/oauth/social-claim';
import { OAUTH_PROVIDER_REGISTRY } from '@/lib/auth/oauth/registry';
import { readSocialClaimCookie } from '@/lib/auth/cookie';
import { SocialConfirmForm } from '@/components/auth/social-confirm-form';
import { m } from '@/messages/ja';

export const dynamic = 'force-dynamic';

/**
 * ソーシャル連携の確認画面（Phase 4-B / D-32-01）。
 *
 * callback で「紐付きが無い」と判定されたときにここへ来る。利用者はここで
 * 「この email でアカウントを作る」または「password でログインして連携する」を選ぶ。
 *
 * - claim の token は **Cookie で運んでいる**ので、この URL には何も載らない（D-32-05）。
 * - claim が無い / 期限切れ / 消費済みなら `/login` へ戻す（画面から操作させない）。
 * - **この画面では何も実行しない**。新規登録も連携も完了 API が行う。
 */
export default async function SocialConfirmPage() {
  const token = await readSocialClaimCookie();
  if (!token) redirect('/login');

  const claim = await findClaim(token);
  if (!claim) redirect('/login');

  const providerLabel =
    OAUTH_PROVIDER_REGISTRY.find((p) => p.id === claim.provider)?.label ?? claim.provider;

  // 「このメールで作る」を出せるのは、検証済みかつ既存アカウントが無いときだけ。
  // 未検証 email で自動登録すると乗っ取りの入口になる（D-32-13）。
  const canSignup = claim.emailVerified && Boolean(claim.providerEmail) && claim.emailOwnerId === null;
  const hasExistingAccount = claim.emailOwnerId !== null;

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