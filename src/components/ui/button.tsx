import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * 既存 CSS 変数（--primary/--primary-fg/--border-strong/--ring …）に写像したボタン。
 * `text-white` は使わない（dark で 2.54:1 しかなく WCAG AA 違反のため D-30-23）。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-bg disabled:pointer-events-none disabled:bg-disabled-bg disabled:text-disabled-fg',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-fg hover:opacity-90',
        secondary: 'border border-border bg-card text-fg hover:bg-hover',
        outline: 'border border-border-strong bg-transparent text-fg hover:bg-hover',
        ghost: 'bg-transparent text-fg hover:bg-hover',
        destructive: 'bg-danger text-danger-fg hover:opacity-90',
        link: 'bg-transparent text-primary underline underline-offset-4',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>
  & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };