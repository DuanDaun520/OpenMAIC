'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function LogoutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await fetch('/api/admin/auth/logout', {
          method: 'POST',
          headers: { 'x-admin-request': '1' },
        }).catch(() => undefined);
        router.replace('/admin/login');
        router.refresh();
      }}
    >
      <LogOut className="size-4" />
      退出登录
    </Button>
  );
}
