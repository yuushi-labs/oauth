import { GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type SocialProviderOption = { id: string; label: string };

/**
 * 社会ログインボタン。registry から生成される（計画 P4-A-01）。
 * 0 件のときは呼び出し側で描画しない（D-30-21）。
 */
export function SocialLoginButtons({ providers }: { providers: SocialProviderOption[] }) {
  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-muted-fg">
        <span className="h-px flex-1 bg-border" />
        <span>または</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {providers.map((provider) => (
        <Button key={provider.id} variant="outline" className="w-full">
          <GitBranch aria-hidden className="size-4" />
          {provider.label} で続行
        </Button>
      ))}
    </div>
  );
}