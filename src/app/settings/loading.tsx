import { Skeleton } from '@/components/ui/skeleton';

/**
 * 設定ページ共通の読み込み表示（Next の route-level `loading.tsx`）。
 * サーバーでのデータ取得中に骨組みを出し、体感待ち時間を短くする。
 */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="読み込み中">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <span className="sr-only">読み込み中</span>
    </div>
  );
}
