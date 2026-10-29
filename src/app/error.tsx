'use client';

import Link from 'next/link';
import { AuthShell } from '@/components/layout/auth-shell';
import { Button } from '@/components/ui/button';
import { m } from '@/messages/ja';

/** Route セグメントのエラー境界。内部詳細は出さず、再試行だけを促す（§45）。 */
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <AuthShell
      title={m('error.unexpectedTitle')}
      description={m('error.unexpectedDescription')}
      footer={
        <p className="text-center text-sm text-muted-fg">
          <Link className="underline" href="/">
            {m('common.backToHome')}
          </Link>
        </p>
      }
    >
      <Button className="w-full" onClick={() => reset()}>
        {m('common.retry')}
      </Button>
    </AuthShell>
  );
}
