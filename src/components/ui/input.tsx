import * as React from 'react';
import { cn } from '@/lib/cn';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /** エラー表示時は true。aria-invalid と danger 枠を自動付与する。 */
  invalid?: boolean;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, invalid, type = 'text', ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-10 w-full rounded-md border border-border-strong bg-bg px-3 py-2 text-sm text-fg',
          'placeholder:text-muted-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          'disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg',
          invalid && 'border-danger',
          className,
        )}
        {...props}
      />
    );
  },
);