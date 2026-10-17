import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * 状態表示は「色＋アイコン＋テキスト」の3点セット固定（§42）。
 * 色だけで状態を伝えないことを構造として強制する。
 */
const alertVariants = cva('flex gap-3 rounded-md border p-4', {
  variants: {
    variant: {
      info: 'border-border bg-card text-fg',
      success: 'border-success bg-success-soft text-fg',
      warning: 'border-warning bg-warning-soft text-fg',
      danger: 'border-danger bg-danger-soft text-fg',
    },
    size: { sm: 'p-3 text-xs', default: 'p-4 text-sm' },
  },
  defaultVariants: { variant: 'info', size: 'default' },
});

const ALERT_ICONS: Record<NonNullable<VariantProps<typeof alertVariants>['variant']>, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: TriangleAlert,
};

export type AlertProps = React.HTMLAttributes<HTMLDivElement>
  & VariantProps<typeof alertVariants>;

export function Alert({ className, variant = 'info', size, children, ...props }: AlertProps) {
  const Icon = ALERT_ICONS[variant ?? 'info'];
  return (
    <div role="alert" className={cn(alertVariants({ variant, size }), className)} {...props}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('font-semibold', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-muted-fg', className)} {...props} />;
}