import type { Metadata } from 'next';
import { AuthForm } from '@/app/auth-form';
import { m } from '@/messages/ja';

export const metadata: Metadata = { title: m('auth.registerTitle') };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
