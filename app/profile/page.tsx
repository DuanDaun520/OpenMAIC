'use client';

/**
 * /profile — personal center for the logged-in product user: presentation
 * identity (avatar / AI nickname / bio, editable here), read-only account
 * info (工号 / 真实姓名, admin-maintained), password change (all other
 * sessions die on success), logout. Self-gating: an expired session on load
 * opens the login modal in place; the auth-changed listener re-runs the load
 * once a session appears.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, KeyRound, Loader2, LogOut, UserRound } from 'lucide-react';

import { SiteHeader } from '@/components/site-header/site-header';
import { UserProfileCard } from '@/components/user-profile';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useAuthModalStore } from '@/lib/store/auth-modal';

interface MeInfo {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  nickname: string | null;
  bio: string | null;
}

export default function ProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<MeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [changing, setChanging] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const loadMe = useCallback(async (openModalOn401: boolean) => {
    try {
      const response = await fetch('/api/auth/me');
      if (response.status === 401) {
        if (openModalOn401) useAuthModalStore.getState().openLogin('/profile');
        return;
      }
      const data = await response.json().catch(() => null);
      if (data?.user) setMe(data.user as MeInfo);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe(true);
    // Login via the modal (or logout elsewhere) re-runs the load in place.
    const onAuthChanged = () => void loadMe(false);
    window.addEventListener('openmaic:auth-changed', onAuthChanged);
    return () => window.removeEventListener('openmaic:auth-changed', onAuthChanged);
  }, [loadMe]);

  async function handleChangePassword(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setMessage({ kind: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    setChanging(true);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-request': '1' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({ kind: 'error', text: data.error || '修改失败，请稍后再试' });
        return;
      }
      setMessage({ kind: 'ok', text: '密码已修改（其他设备的登录已全部退出）' });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      setMessage({ kind: 'error', text: '网络错误，请稍后再试' });
    } finally {
      setChanging(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-user-request': '1' },
      });
      window.dispatchEvent(new Event('openmaic:auth-changed'));
      router.replace('/');
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="bg-gradient-to-b from-sky-50 via-white to-indigo-50 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950 min-h-[100dvh]">
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-28 md:px-8">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
        >
          <ArrowLeft className="size-4" /> 返回首页
        </Link>

        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 py-16 text-sm">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        ) : !me ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              未登录，
              <button
                type="button"
                className="text-primary underline"
                onClick={() => useAuthModalStore.getState().openLogin('/profile')}
              >
                去登录
              </button>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Avatar / AI 昵称 / 简介 — the user's own presentation identity,
                synced with the account (see lib/store/user-profile.ts). */}
            <UserProfileCard />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <UserRound className="size-5" /> 基本信息
                </CardTitle>
                <CardDescription>账号信息由管理员维护，如需修改请联系管理员</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-[88px_1fr] items-center gap-y-3 text-sm">
                <span className="text-muted-foreground">工号</span>
                <span className="font-medium">{me.username}</span>
                <span className="text-muted-foreground">真实姓名</span>
                <span className="font-medium">{me.displayName ?? '—'}</span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <KeyRound className="size-5" /> 修改密码
                </CardTitle>
                <CardDescription>修改成功后，其他设备的登录状态将全部失效</CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={handleChangePassword}
                  className="flex max-w-sm flex-col gap-4"
                  id="change-password-form"
                >
                  {message ? (
                    <Alert variant={message.kind === 'error' ? 'destructive' : 'default'}>
                      <AlertDescription>{message.text}</AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="old-password">当前密码</Label>
                    <Input
                      id="old-password"
                      type="password"
                      value={oldPassword}
                      onChange={(event) => setOldPassword(event.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="new-password">新密码</Label>
                    <Input
                      id="new-password"
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={6}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="confirm-password">确认新密码</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={6}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={changing} className="w-fit">
                    {changing ? <Loader2 className="size-4 animate-spin" /> : null}
                    保存新密码
                  </Button>
                </form>
              </CardContent>
              <Separator />
              <CardFooter className="justify-between pt-4">
                <span className="text-muted-foreground text-sm">退出当前账号</span>
                <Button variant="outline" onClick={handleLogout} disabled={loggingOut}>
                  {loggingOut ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LogOut className="size-4" />
                  )}
                  退出登录
                </Button>
              </CardFooter>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
