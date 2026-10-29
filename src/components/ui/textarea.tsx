import * as React from 'react';
import { cn } from '@/lib/cn';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** エラー表示時は true。aria-invalid と danger 枠を自動付与する。 */
  invalid?: boolean;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm text-fg',
        'placeholder:text-muted-fg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    />
  );
});
