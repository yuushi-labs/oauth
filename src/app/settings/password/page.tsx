import { requireSettingsUser } from '@/app/settings/layout';
import { PasswordChangeForm } from '@/components/settings/password-change-form';

export const dynamic = 'force-dynamic';

/** パスワード変更（§37 の「[変更]」の行き先）。既存 API を再利用する（D-30-20）。 */
export default async function SettingsPasswordPage() {
  await requireSettingsUser();
  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold">パスワード</h1>
      </header>
      <PasswordChangeForm />
    </main>
  );
}