/**
 * `/admin/*` panel shell — the authoritative page-side session gate.
 *
 * `proxy.ts` performs only an optimistic cookie-presence check; this layout
 * validates the session against the database (and re-checks account status)
 * before rendering any panel page. Pages that skip this layout (login) are
 * unauthenticated by design.
 */
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { AdminNav } from '@/components/admin/admin-nav';
import { LogoutButton } from '@/components/admin/logout-button';
import { validateAdminSession } from '@/lib/admin/auth';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/session-cookie';

export const dynamic = 'force-dynamic';

export default async function AdminPanelLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const session = await validateAdminSession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value).catch(
    () => null,
  );
  if (!session) {
    redirect('/admin/login');
  }

  return (
    <div className="bg-background flex min-h-screen">
      <aside className="bg-muted/40 hidden w-56 shrink-0 flex-col gap-6 border-r p-4 md:flex">
        <div className="px-3 py-2">
          <div className="text-sm font-semibold">AI Classroom 管理后台</div>
          <div className="text-muted-foreground text-xs">v1.0.3 · P0</div>
        </div>
        <AdminNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-6 py-3">
          <div className="text-sm text-[#666]">
            管理员：<span className="text-foreground font-medium">{session.username}</span>
            <span className="text-muted-foreground ml-2 text-xs">
              {session.role === 'super_admin'
                ? '超级管理员'
                : session.role === 'admin'
                  ? '管理员'
                  : '操作员'}
            </span>
          </div>
          <LogoutButton />
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
