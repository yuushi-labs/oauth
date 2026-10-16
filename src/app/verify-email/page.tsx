import { VerifyEmailForm } from '@/app/verify-email-form';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-bold">メールアドレスの確認</h1>
        <p className="mt-2 text-sm text-muted-fg">登録を完了するには、下のボタンを押してください。</p>
      </header>
      <VerifyEmailForm token={token ?? ''} />
    </main>
  );
}
