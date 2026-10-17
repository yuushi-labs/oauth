import { configuredOAuthProviders } from '@/lib/auth/oauth/registry';
import { SocialLoginButtons } from '@/components/auth/social-login-buttons';

/**
 * ログインボタン（registry 驱动）。
 *
 * 認証方式は registry から自動生成し、**0 件なら領域ごと描画しない**（D-30-21）。
 * 现阶段は社会ログイン（Phase 4）・passkey（Phase 6）が空なので何も描画されない。
 */
export function LoginButtons() {
  // サーバー側で env を判定し、client secret などの機密値を露出させない（§45）
  const providers = configuredOAuthProviders({
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  });

  if (providers.length === 0) return null;

  return (
    <>
      <SocialLoginButtons providers={providers.map((provider) => ({ id: provider.id, label: provider.label }))} />
      {/* passkey ボタンは Phase 6 で registry に追加したらここに出る */}
    </>
  );
}