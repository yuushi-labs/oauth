'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/settings/account', label: 'アカウント' },
  { href: '/settings/connected-apps', label: '接続済みサービス' },
  { href: '/settings/applications', label: 'アプリケーション' },
] as const;

export function SettingsNav() {
  const pathname = usePathname() ?? '/settings';
  const currentPath = pathname.startsWith('/settings/applications') ? '/settings/applications' : pathname;

  return (
    <nav aria-label="設定メニュー" className="rounded-lg border border-border bg-card p-4">
      <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {items.map((item) => {
          const isCurrent = currentPath === item.href;
          return (
            <li key={item.href}>
              <Link
                aria-current={isCurrent ? 'page' : undefined}
                className={`block rounded-md border px-3 py-2 text-sm ${isCurrent ? 'border-primary font-semibold' : 'border-border hover:border-primary'}`}
                href={item.href}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
