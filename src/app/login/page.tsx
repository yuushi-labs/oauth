import { AuthForm } from '@/app/auth-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  return <AuthForm mode="login" returnTo={returnTo} />;
}
