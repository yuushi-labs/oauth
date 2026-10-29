import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/layout/auth-shell';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('error.notFoundTitle') };

/** 404。静的なので Next が自動で返す。 */
export default function NotFound() {
  return (
    <AuthShell title={m('error.notFoundTitle')} description={m('error.notFoundDescription')}>
      <Link className={cn(buttonVariants(), 'w-full')} href="/">
        {m('common.backToHome')}
      </Link>
    </AuthShell>
  );
}
