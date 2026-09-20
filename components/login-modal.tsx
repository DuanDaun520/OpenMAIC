'use client';

/**
 * The global login modal. Mounted once in the root layout and driven by
 * `useAuthModalStore` — every surface that used to navigate to /login opens
 * this instead, so login happens in place over whatever the user was doing.
 * On success the auth-changed dispatch (inside the form) refreshes the
 * header, the profile sync, and any gated page; this component then closes
 * and applies the optional `next` destination.
 */
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';

import { LoginForm } from '@/components/login-form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useAuthModalStore } from '@/lib/store/auth-modal';

export function LoginModal() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const open = useAuthModalStore((s) => s.open);
  const next = useAuthModalStore((s) => s.next);
  const close = useAuthModalStore((s) => s.close);

  const handleSuccess = () => {
    close();
    router.refresh();
    // Only navigate when the opener asked for a different page (gates pass
    // their own path; staying put lets the auth-changed listeners refill it).
    if (next && next !== pathname) router.replace(next);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="items-center text-center">
          <div className="mb-2 flex items-center justify-center gap-2.5">
            <Image src="/logo.png" alt="AI Classroom" width={44} height={40} className="h-10 w-auto" />
            <span className="text-xl font-bold tracking-tight">AI Classroom</span>
          </div>
          <DialogTitle className="text-xl">{t('login.title')}</DialogTitle>
          <DialogDescription>{t('login.description')}</DialogDescription>
        </DialogHeader>
        <LoginForm onSuccess={handleSuccess} />
      </DialogContent>
    </Dialog>
  );
}
