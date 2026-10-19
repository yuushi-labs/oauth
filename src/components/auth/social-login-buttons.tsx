import { GitBranch } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { m } from '@/messages/ja';

export type SocialProviderOption = { id: string; label: string };

/**
 * 社会ログインボタン。registry から生成される（計画 P4-A-01）。
 * 0 件のときは呼び出し側で描画しない（D-30-21）。
 *
 * 遷移は provider の authorize URL への**通常のリンク**にする。JS を介さないので、
 * JS が失敗しても連携画面だけは使える。
 */
export function SocialLoginButtons({ providers }: { providers: SocialProviderOption[] }) {
  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-muted-fg">
        <span className="h-px flex-1 bg-border" />
        <span>{m('common.or')}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {providers.map((provider) => (
        <a
          key={provider.id}
          className={buttonVariants({ variant: 'outline' }) + ' w-full'}
          href={`/api/auth/oauth/${provider.id}`}
        >
          <GitBranch aria-hidden className="size-4" />
          {m('oauth.providerLabel', { provider: provider.label })}
        </a>
      ))}
    </div>
  );
}