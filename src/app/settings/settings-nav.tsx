'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AppWindow,
  ChevronDown,
  KeyRound,
  Link2,
  Menu,
  MonitorSmartphone,
  Palette,
  Plug,
  ShieldCheck,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { m } from '@/messages/ja';

type NavItem = { href: string; label: string; Icon: LucideIcon };

const items: readonly NavItem[] = [
  { href: '/settings/account', label: m('settings.account'), Icon: UserRound },
  { href: '/settings/security', label: m('settings.security'), Icon: ShieldCheck },
  { href: '/settings/sessions', label: m('settings.sessions'), Icon: MonitorSmartphone },
  { href: '/settings/password', label: m('settings.password'), Icon: KeyRound },
  { href: '/settings/appearance', label: m('settings.appearance'), Icon: Palette },
  { href: '/settings/connected-accounts', label: m('settings.connectedAccounts'), Icon: Link2 },
  { href: '/settings/connected-apps', label: m('settings.connectedApps'), Icon: Plug },
  { href: '/settings/applications', label: m('settings.applications'), Icon: AppWindow },
] as const;

const NAV_ID = 'settings-nav';

/**
 * 設定メニュー（§37）。
 *
 * モバイル（lg 未満）はハンバーガーで開閉する縦並び、デスクトップ（lg 以上）は
 * 常時表示のサイドバーに切り替える。表示は 1 つの `<ul>` を CSS で出し分けるため、
 * リンク先・項目数はどの幅でも同じ（機能は変えない）。
 */
export function SettingsNav() {
  const pathname = usePathname() ?? '/settings';
  const currentPath = pathname.startsWith('/settings/applications')
    ? '/settings/applications'
    : pathname;
  const [open, setOpen] = useState(false);

  // 遷移したらメニューを閉じる（モバイルで開いたままにならない）
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape で閉じる（キーボード操作）
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="lg:w-64 lg:shrink-0 lg:self-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={NAV_ID}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium text-fg',
          'hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'lg:hidden',
        )}
      >
        {open ? (
          <X aria-hidden className="size-5 shrink-0" />
        ) : (
          <Menu aria-hidden className="size-5 shrink-0" />
        )}
        <span>{m('settings.menu')}</span>
        <ChevronDown
          aria-hidden
          className={cn('ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      <nav
        id={NAV_ID}
        aria-label={m('settings.menu')}
        className={cn(
          'mt-2 rounded-lg border border-border bg-card p-2',
          'lg:mt-0 lg:block',
          open ? 'block' : 'hidden',
        )}
      >
        <p className="hidden px-3 py-2 text-sm font-semibold text-fg lg:block">
          {m('settings.title')}
        </p>
        <ul className="flex flex-col gap-1">
          {items.map(({ href, label, Icon }) => {
            const isCurrent = currentPath === href;
            return (
              <li key={href}>
                <Link
                  aria-current={isCurrent ? 'page' : undefined}
                  href={href}
                  className={cn(
                    'flex items-center gap-3 rounded-md border px-3 py-2 text-sm',
                    isCurrent
                      ? 'border-primary bg-hover font-semibold text-fg'
                      : 'border-transparent text-fg hover:bg-hover',
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-fg" />
                  <span>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
