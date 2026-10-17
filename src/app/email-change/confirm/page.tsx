import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { EmailChangeForm } from '@/app/email-change/confirm/email-change-form';

/**
 * `POST /api/auth/email/change` が送るメール内 URL は
 * `/api/auth/email/change/confirm?token=...`。その GET は 303 でこのページに
 * 転送される（BUG-2 で GET ハンドラを追加）。ここでの確定は POST のみ（§25）。
 */
export default async function EmailChangeConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <header className="mb-8 text-center">
        <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">メールアドレスの変更確認</h1>
        <p className="mb-6 text-sm text-muted-fg">
          新しいメールアドレスの確認を完了するには、下のボタンを押してください。
        </p>
        <EmailChangeForm token={token ?? ''} />
        <p className="mt-6 text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">ログインに戻る</Link>
        </p>
      </section>
    </main>
  );
}