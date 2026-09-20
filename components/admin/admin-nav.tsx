'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AudioLines,
  BarChart3,
  BookOpen,
  Coins,
  FolderTree,
  LayoutDashboard,
  SlidersHorizontal,
  Tags,
  Users,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/admin', label: '概览', icon: LayoutDashboard },
  { href: '/admin/models', label: '模型配置', icon: SlidersHorizontal },
  { href: '/admin/voices', label: '音色管理', icon: AudioLines },
  { href: '/admin/users', label: '用户管理', icon: Users },
  { href: '/admin/usage', label: '用量统计', icon: BarChart3 },
  { href: '/admin/quota', label: '额度管理', icon: Coins },
  { href: '/admin/courses', label: '课程管理', icon: BookOpen },
  { href: '/admin/categories', label: '分类管理', icon: FolderTree },
  { href: '/admin/tags', label: '标签管理', icon: Tags },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
