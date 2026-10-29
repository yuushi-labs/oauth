import { cn } from '@/lib/cn';

/** 読み込み中のプレースホルダ。`aria-hidden` で読み上げ対象から外す。 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div aria-hidden className={cn('animate-pulse rounded-md bg-hover', className)} {...props} />
  );
}
