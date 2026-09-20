'use client';

/**
 * Site-wide top banner — a fixed 80px (h-20) bar: logo + product name, the
 * primary nav destinations, and the right-hand user center (login/avatar).
 * Mounts on the portal-style pages (home / explore / my-courses / profile);
 * immersive surfaces (classroom, editor, admin) keep their own chrome.
 *
 * Session state is fetched from /api/auth/me and refreshed on the
 * `openmaic:auth-changed` window event, which /login and /profile fire after
 * every auth mutation — so every mounted header flips state in lockstep.
 */
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, LogIn, LogOut, Menu, UserRound } from 'lucide-react';

import { fetchAuthMe } from '@/lib/auth/auth-me-client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { cn } from '@/lib/utils';
import { useAuthModalStore } from '@/lib/store/auth-modal';

const NAV_ITEMS = [
  { href: '/', label: '首页' },
  { href: '/explore', label: '学习天地' },
  { href: '/my-courses', label: '我的课程' },
] as const;

interface MeInfo {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export function SiteHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<MeInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const refreshMe = useCallback(async () => {
    // Shared cache (one /api/auth/me per load across layout/page/header);
    // refresh bypasses it for remounts after soft navigation.
    const snapshot = await fetchAuthMe<{ user?: MeInfo | null }>({ refresh: true });
    setMe(snapshot.ok ? (snapshot.body?.user ?? null) : null);
    setChecking(false);
  }, []);

  useEffect(() => {
    void refreshMe();
    const onAuthChanged = () => void refreshMe();
    window.addEventListener('openmaic:auth-changed', onAuthChanged);
    return () => window.removeEventListener('openmaic:auth-changed', onAuthChanged);
  }, [refreshMe]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-user-request': '1' },
      });
      window.dispatchEvent(new Event('openmaic:auth-changed'));
      // Gated pages have nothing to show a logged-out visitor; elsewhere a
      // refresh is enough to re-render member-only bits.
      if (pathname.startsWith('/my-courses') || pathname.startsWith('/profile')) {
        router.replace('/');
      } else {
        router.refresh();
      }
    } finally {
      setLoggingOut(false);
    }
  }

  const openLogin = useAuthModalStore((s) => s.openLogin);

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-20 border-b border-gray-200/70 bg-white/85 backdrop-blur-md dark:border-slate-800/70 dark:bg-slate-950/85">
      <div className="mx-auto flex h-full w-full max-w-7xl items-center justify-between gap-4 px-4 md:px-6">
        {/* Logo + product name + primary nav */}
        <div className="flex h-full min-w-0 items-center gap-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5"
            aria-label="AI Classroom 首页"
          >
            <Image
              src="/logo.png"
              alt="AI Classroom"
              width={40}
              height={36}
              className="h-9 w-auto"
              priority
            />
            <span className="hidden text-lg font-bold tracking-tight sm:inline">AI Classroom</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-full px-4 py-2 text-sm font-medium transition-colors',
                  isActive(item.href)
                    ? 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-slate-800 dark:hover:text-gray-100',
                )}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Right cluster: settings / user center */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Mobile nav (the four destinations don't fit small screens) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 md:hidden dark:text-gray-400 dark:hover:bg-slate-800 dark:hover:text-gray-100"
                aria-label="打开菜单"
              >
                <Menu className="size-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8}>
              {NAV_ITEMS.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {checking ? (
            <span className="text-muted-foreground inline-flex size-9 items-center justify-center">
              <Loader2 className="size-4 animate-spin" />
            </span>
          ) : me ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-full border border-gray-200 py-1 pl-1 pr-3 transition-colors hover:bg-gray-100 dark:border-slate-700 dark:hover:bg-slate-800"
                  aria-label="用户中心"
                >
                  <span className="inline-flex size-7 items-center justify-center overflow-hidden rounded-full bg-purple-100 text-xs font-bold text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                    <AvatarDisplay src={me.avatarUrl || (me.displayName || me.username).slice(0, 1).toUpperCase()} alt="" />
                  </span>
                  <span className="max-w-24 truncate text-sm font-medium">
                    {me.displayName || me.username}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8} className="min-w-[160px]">
                <DropdownMenuItem asChild>
                  <Link href="/profile" className="cursor-pointer">
                    <UserRound className="size-4" /> 个人中心
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                  disabled={loggingOut}
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleLogout();
                  }}
                >
                  <LogOut className="size-4" /> 退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              size="sm"
              className="ml-1 rounded-full"
              onClick={() => openLogin(pathname || '/')}
            >
              <LogIn className="size-4" /> 登录
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
