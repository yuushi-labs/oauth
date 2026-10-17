import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { ForgotPasswordForm } from '@/app/forgot-password/forgot-password-form';

export default async function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <header className="mb-8 text-center">
        <Link className="text-2xl font-bold" href="/login">{APP_NAME}</Link>
      </header>
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">パスワードの再設定</h1>
        <p className="mb-6 text-sm text-muted-fg">
          登録したメールアドレスを入力してください。再設定用のリンクをお送りします。
        </p>
        <ForgotPasswordForm />
        <p className="mt-6 text-center text-sm text-muted-fg">
          <Link className="underline" href="/login">ログインに戻る</Link>
        </p>
      </section>
    </main>
  );
}