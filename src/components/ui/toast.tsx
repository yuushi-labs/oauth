'use client';

import * as React from 'react';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';

type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export type ToastMessage = {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
};

type ToastInput = Omit<ToastMessage, 'id'>;

const ToastContext = React.createContext<{ push: (toast: ToastInput) => void } | null>(null);

/**
 * 画面内トースト。成功は role="status"、エラーは role="alert" で読み上げる（§42/§13.1）。
 * 色＋アイコン＋テキストで状態を表現する。
 */
export function ToastProvider({ children, duration = 5000 }: { children: React.ReactNode; duration?: number }) {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const nextId = React.useRef(1);

  const push = React.useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), duration);
  }, [duration]);

  const value = React.useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => setToasts((c) => c.filter((i) => i.id !== toast.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const Icon = toast.variant === 'success' ? CircleCheck : toast.variant === 'danger' || toast.variant === 'warning' ? TriangleAlert : Info;
  return (
    <div
      role={toast.variant === 'danger' ? 'alert' : 'status'}
      aria-live={toast.variant === 'danger' ? 'assertive' : 'polite'}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border border-border bg-card p-3 shadow-lg"
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{toast.title}</p>
        {toast.description && <p className="text-xs text-muted-fg">{toast.description}</p>}
      </div>
      <button type="button" onClick={onClose} className="text-xs text-muted-fg hover:text-fg" aria-label="閉じる">
        ×
      </button>
    </div>
  );
}

export function useToast(): { push: (toast: ToastInput) => void } {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export const toastTone: Record<ToastVariant, string> = {
  info: 'text-fg',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export { cn };