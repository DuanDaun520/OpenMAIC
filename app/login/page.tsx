'use client';

/**
 * /login — deep-link fallback for the login modal. The primary login surface
 * is now the global modal (components/login-modal.tsx, opened in place by the
 * header and every gate); this route keeps bookmarked `/login?next=…` links
 * working with the same shared form. No registration: accounts are created
 * in the admin console and distributed (本产品不开通自助注册).
 */
import { Suspense } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { LoginForm } from '@/components/login-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useI18n } from '@/lib/hooks/use-i18n';

function LoginCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();

  const nextParam = searchParams.get('next');
  const next =
    nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex items-center justify-center gap-2.5">
          <Image
            src="/logo.png"
            alt="AI Classroom"
            width={44}
            height={40}
            className="h-10 w-auto"
            priority
          />
          <span className="text-xl font-bold tracking-tight">AI Classroom</span>
        </div>
        <CardTitle className="text-xl">{t('login.title')}</CardTitle>
        <CardDescription>{t('login.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm
          onSuccess={() => {
            router.replace(next);
            router.refresh();
          }}
        />
      </CardContent>
      <CardFooter className="justify-center text-muted-foreground text-xs">
        <Link href="/" className="hover:text-foreground underline-offset-4 hover:underline">
          ← {t('login.backHome')}
        </Link>
      </CardFooter>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="bg-gradient-to-b from-sky-50 via-white to-indigo-50 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950 flex min-h-screen flex-col items-center justify-center p-4">
      <Suspense fallback={null}>
        <LoginCard />
      </Suspense>
    </main>
  );
}
