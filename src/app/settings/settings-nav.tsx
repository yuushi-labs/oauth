'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { m } from '@/messages/ja';

const items = [
  { href: '/settings/account', label: m('settings.account') },
  { href: '/settings/security', label: m('settings.security') },
  { href: '/settings/sessions', label: m('settings.sessions') },
  { href: '/settings/password', label: m('settings.password') },
  { href: '/settings/appearance', label: m('settings.appearance') },
  { href: '/settings/connected-apps', label: m('settings.connectedApps') },
  { href: '/settings/applications', label: m('settings.applications') },
] as const;

export function SettingsNav() {
  const pathname = usePathname() ?? '/settings';
  const currentPath = pathname.startsWith('/settings/applications') ? '/settings/applications' : pathname;

  return (
    <nav aria-label={m('settings.menu')} className="rounded-lg border border-border bg-card p-4">
      <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {items.map((item) => {
          const isCurrent = currentPath === item.href;
          return (
            <li key={item.href}>
              <Link
                aria-current={isCurrent ? 'page' : undefined}
                className={`block rounded-md border px-3 py-2 text-sm ${isCurrent ? 'border-primary font-semibold' : 'border-border-strong hover:border-primary'}`}
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