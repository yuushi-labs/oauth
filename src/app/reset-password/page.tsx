import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { ResetPasswordForm } from '@/app/reset-password/reset-password-form';

/**
 * GET は画面表示のみ。パスワードの変更は画面内の POST で行う（§25）。
 * この画面が指す URL は `POST /api/auth/password/forgot` が送る
 * `/reset-password?token=...`（BUG-1 で旧 `/password/reset` から修正済み）。
 */
export default async function ResetPasswordPage({
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
        <h1 className="mb-2 text-xl font-semibold">新しいパスワード</h1>
        <p className="mb-6 text-sm text-muted-fg">
          新しいパスワードを入力してください。変更すると他のデバイスからはログアウトされます。
        </p>
        <ResetPasswordForm token={token ?? ''} />
        <p className="mt-6 text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">ログインに戻る</Link>
        </p>
      </section>
    </main>
  );
}