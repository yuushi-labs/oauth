import { configuredOAuthProviders, oauthEnvKeys } from '@/lib/auth/oauth/registry';
import { SocialLoginButtons } from '@/components/auth/social-login-buttons';

/**
 * ログインボタン（registry 駆動）。
 *
 * 認証方式は registry から自動生成し、**0 件なら領域ごと描画しない**（D-30-21）。
 * 鍵の組み合わせは registry の `envKeys` から取るので、provider を増やしても
 * このファイルを手直ししなくてよい。
 */
export function LoginButtons() {
  // サーバー側で env を判定し、**id と label だけ**をクライアントへ渡す。
  // client_secret などの機密値をバンドルへ載せない（§45）。
  const envSubset: Record<string, string | undefined> = {};
  for (const key of oauthEnvKeys()) envSubset[key] = process.env[key];

  const providers = configuredOAuthProviders(envSubset);

  if (providers.length === 0) return null;

  return (
    <>
      <SocialLoginButtons
        providers={providers.map((provider) => ({ id: provider.id, label: provider.label }))}
      />
      {/* passkey ボタンは Phase 6 で registry に追加したらここに出る */}
    </>
  );
}