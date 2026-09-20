'use client';

/**
 * /explore — 学习天地: the public shelf of admin-published courses. Anyone
 * may browse; opening a course deep-links into its classroom (stage reads are
 * capability-by-id in the document store, so a published id plays for any
 * visitor while writes stay owner-only).
 *
 * Card covers follow the same chain as 我的课程: explicit AI cover > first
 * slide thumbnail > deterministic gradient (lib/utils/cover-gradient, shared
 * with every shelf). Beyond the cover, each card carries three affordances:
 *
 *  - 收藏 star (cover top-left): the same POST /api/my-courses write the
 *    我的课程 shelf uses, so a favorited course lands in that shelf's
 *    收藏课程 tab. Favoriting binds to the signed-in account (that shelf is
 *    login-gated) — an anonymous tap opens the login modal and the pending
 *    star completes itself once a session appears (openmaic:auth-changed).
 *  - 作者真实姓名 (meta row, right-aligned): resolved server-side from
 *    user_accounts; anonymous authors render as 匿名用户.
 *  - Hovering the truncated 简介 opens a HoverCard with the full
 *    title / description / author facts.
 *
 * Search + category chips filter the loaded list locally — the shelf is
 * capped at 200 courses, so no server round-trip is warranted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, Compass, Loader2, Search, Star, User } from 'lucide-react';
import { toast } from 'sonner';

import { SiteHeader } from '@/components/site-header/site-header';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Input } from '@/components/ui/input';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { cn } from '@/lib/utils';
import { coverGradient } from '@/lib/utils/cover-gradient';
import { useAuthModalStore } from '@/lib/store/auth-modal';
import { isSlideContent } from '@/lib/types/stage';

interface ExploreCourse {
  id: string;
  name: string;
  description: string | null;
  sceneCount: number;
  updatedAt: string;
  categoryName: string | null;
  isFavorite: boolean;
  /** 作者真实姓名 (display_name > AI 昵称 > 工号); null = anonymous author. */
  authorName?: string | null;
  coverUrl?: string;
  /** Serialized first slide — rendered as the card cover when there is no AI cover. */
  firstScene?: { content?: unknown };
}

export default function ExplorePage() {
  const [courses, setCourses] = useState<ExploreCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [loggedIn, setLoggedIn] = useState(false);
  // The course an anonymous visitor tapped 收藏 on — completed automatically
  // once the login modal that tap opened produces a session.
  const pendingFavoriteIdRef = useRef<string | null>(null);

  const loadCourses = useCallback(async () => {
    try {
      const response = await fetch('/api/explore');
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.error || '暂时无法加载课程列表');
        return;
      }
      setError(null);
      setCourses(data?.courses ?? []);
    } catch {
      setError('网络错误，请稍后再试');
    }
  }, []);

  const checkAuth = useCallback(async (): Promise<boolean> => {
    try {
      const ok = (await fetch('/api/auth/me')).ok;
      setLoggedIn(ok);
      return ok;
    } catch {
      setLoggedIn(false);
      return false;
    }
  }, []);

  /** Optimistic favorite flip via the 我的课程 write; reverts on failure. */
  const favoriteCourse = useCallback(async (stageId: string, favorite: boolean) => {
    setCourses((prev) =>
      prev ? prev.map((c) => (c.id === stageId ? { ...c, isFavorite: favorite } : c)) : prev,
    );
    try {
      const response = await fetch('/api/my-courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'favorite', stageId, favorite }),
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      setCourses((prev) =>
        prev ? prev.map((c) => (c.id === stageId ? { ...c, isFavorite: !favorite } : c)) : prev,
      );
      toast.error(favorite ? '收藏失败，请重试' : '取消收藏失败，请重试');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await checkAuth();
      if (!cancelled) await loadCourses();
    })();
    const onAuthChanged = () => {
      void (async () => {
        // Favorite flags are owner-scoped: a new session means a new owner,
        // so reload the shelf, then finish the star that opened the modal.
        const ok = await checkAuth();
        await loadCourses();
        const pendingId = pendingFavoriteIdRef.current;
        if (ok && pendingId) {
          pendingFavoriteIdRef.current = null;
          await favoriteCourse(pendingId, true);
        }
      })();
    };
    window.addEventListener('openmaic:auth-changed', onAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('openmaic:auth-changed', onAuthChanged);
    };
  }, [checkAuth, loadCourses, favoriteCourse]);

  const toggleFavorite = (course: ExploreCourse) => {
    if (!loggedIn) {
      // 收藏落到登录账号名下（我的课程 也需登录）— 先补登录，成功后自动完成。
      pendingFavoriteIdRef.current = course.id;
      toast('请先登录后再收藏');
      useAuthModalStore.getState().openLogin('/explore');
      return;
    }
    void favoriteCourse(course.id, !course.isFavorite);
  };

  // Categories present on the shelf (published courses only), in first-seen
  // order — the chips are data-driven, so the admin's 分类管理 shows up here
  // without any hardcoded list.
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const course of courses ?? []) {
      if (course.categoryName && !seen.includes(course.categoryName))
        seen.push(course.categoryName);
    }
    return seen;
  }, [courses]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (courses ?? []).filter((course) => {
      if (category !== 'all' && course.categoryName !== category) return false;
      if (keyword && !course.name.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [courses, query, category]);

  return (
    <div className="bg-gradient-to-b from-sky-50 via-white to-indigo-50 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950 min-h-[100dvh]">
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-28 md:px-8">
        {/* ── Hero ── */}
        <section className="relative mb-8 overflow-hidden rounded-3xl border border-border/60 bg-white/70 dark:bg-slate-900/70 px-6 py-8 shadow-sm backdrop-blur md:px-10 md:py-10">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full bg-gradient-to-br from-purple-400/30 to-indigo-400/30 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-10 size-64 rounded-full bg-gradient-to-br from-sky-400/25 to-cyan-300/25 blur-3xl"
          />
          <div className="relative flex items-center gap-4">
            <span className="bg-gradient-to-br from-purple-500 to-indigo-500 inline-flex size-12 items-center justify-center rounded-2xl text-white shadow-md shadow-purple-500/25">
              <Compass className="size-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold md:text-3xl">学习天地</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                大家创造的优秀公开课程，点击即可进入学习
              </p>
            </div>
          </div>
        </section>

        {/* ── Toolbar: search + category chips ── */}
        {courses !== null && !error && courses.length > 0 ? (
          <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-xs">
              <Search className="text-muted-foreground/70 pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
              <Input
                className="pl-9"
                placeholder="搜索课程…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {categories.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <CategoryChip
                  label="全部"
                  active={category === 'all'}
                  onClick={() => setCategory('all')}
                />
                {categories.map((name) => (
                  <CategoryChip
                    key={name}
                    label={name}
                    active={category === name}
                    onClick={() => setCategory(name)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── Shelf ── */}
        {courses === null && !error ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="animate-pulse overflow-hidden rounded-2xl border border-border/60 bg-white/60 dark:bg-slate-900/60"
              >
                <div className="aspect-video w-full bg-muted/60" />
                <div className="flex flex-col gap-2.5 p-4">
                  <div className="h-4 w-3/4 rounded bg-muted/60" />
                  <div className="h-3 w-1/2 rounded bg-muted/40" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <span className="bg-muted text-muted-foreground inline-flex size-12 items-center justify-center rounded-full">
              <Loader2 className="size-6" />
            </span>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
        ) : courses?.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <span className="bg-gradient-to-br flex size-12 items-center justify-center rounded-full from-purple-100 to-indigo-100 text-purple-500 dark:from-purple-900/40 dark:to-indigo-900/40 dark:text-purple-300">
              <BookOpen className="size-6" />
            </span>
            <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
              还没有已发布的课程。生成一门课程后，可由管理员在后台发布到这里。
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <span className="bg-muted text-muted-foreground inline-flex size-12 items-center justify-center rounded-full">
              <Search className="size-6" />
            </span>
            <p className="text-muted-foreground text-sm">
              没有符合条件的课程，换个关键词或分类试试
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((course) => (
              <ExploreCard key={course.id} course={course} onToggleFavorite={toggleFavorite} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-purple-400/60 bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-200'
          : 'border-border/60 bg-background/60 text-muted-foreground hover:border-purple-300 hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

// ─── Course card — cover chain mirrors 我的课程 ───────────────
// Structured like the 我的课程 card (root div, cover + body as sibling Links)
// so the 收藏 star is a button ON the card rather than inside an anchor.
function ExploreCard({
  course,
  onToggleFavorite,
}: {
  course: ExploreCourse;
  onToggleFavorite: (course: ExploreCourse) => void;
}) {
  const canvas = firstSlideCanvas(course);
  const author = course.authorName ?? '匿名用户';

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-white/80 shadow-sm backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:bg-slate-900/80">
      {/* Cover — AI cover > first-slide thumbnail > gradient */}
      <Link
        href={`/classroom/${course.id}`}
        className="relative block aspect-video w-full overflow-hidden bg-muted/40"
      >
        {course.coverUrl ? (
          <img
            src={course.coverUrl}
            alt={course.name}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : canvas ? (
          <div className="size-full transition-transform duration-300 group-hover:scale-[1.03]">
            <SlideThumbnail slide={canvas} viewportRatio={0.5625} />
          </div>
        ) : (
          <div
            className={cn(
              'flex size-full items-center justify-center bg-gradient-to-br transition-transform duration-300 group-hover:scale-[1.03]',
              coverGradient(course.id),
            )}
          >
            <BookOpen className="size-7 text-white/90" />
          </div>
        )}

        {/* Category badge (top-right — the top-left corner belongs to 收藏) */}
        {course.categoryName ? (
          <span className="absolute right-2.5 top-2.5 inline-flex max-w-[60%] items-center truncate rounded-full bg-black/35 px-2.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
            {course.categoryName}
          </span>
        ) : null}

        {/* Hover affordance */}
        <span className="absolute inset-y-0 right-0 flex items-center pr-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="bg-black/40 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
            进入学习
            <ArrowRight className="size-3" />
          </span>
        </span>
      </Link>

      {/* 收藏 — the same write 我的课程 uses, so the course shows up in that
          shelf's 收藏课程 tab */}
      <button
        type="button"
        onClick={() => onToggleFavorite(course)}
        aria-label={course.isFavorite ? '取消收藏' : '收藏课程'}
        className={cn(
          'absolute left-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-full backdrop-blur-sm transition-colors',
          course.isFavorite
            ? // 已收藏：白色圆底 + 黄色圆环 + 黄色五角星
              'bg-white text-amber-400 ring-2 ring-amber-400 hover:bg-amber-50'
            : 'bg-black/30 text-white hover:bg-black/50',
        )}
      >
        <Star
          className={cn(
            'size-4 transition-colors',
            course.isFavorite && 'fill-amber-400 text-amber-400',
          )}
        />
      </button>

      {/* Body */}
      <Link href={`/classroom/${course.id}`} className="flex flex-1 flex-col p-4">
        <h2 className="line-clamp-2 font-semibold leading-snug transition-colors group-hover:text-purple-600 dark:group-hover:text-purple-400">
          {course.name}
        </h2>
        {course.description ? (
          // Hovering the truncated 简介 opens the full course facts.
          <HoverCard openDelay={300} closeDelay={100}>
            <HoverCardTrigger asChild>
              <p className="text-muted-foreground mt-1.5 line-clamp-2 cursor-default text-xs leading-relaxed">
                {course.description}
              </p>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" align="start" className="w-80">
              <p className="line-clamp-2 font-semibold leading-snug">{course.name}</p>
              <p className="text-muted-foreground mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
                {course.description}
              </p>
              <div className="bg-border/60 my-2.5 h-px" />
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="inline-flex min-w-0 items-center gap-1">
                  <User className="size-3.5 shrink-0" />
                  <span className="truncate">{author}</span>
                </span>
                {course.categoryName ? <span>{course.categoryName}</span> : null}
                <span className="tabular-nums">{course.sceneCount} 页</span>
                <span className="tabular-nums">
                  {new Date(course.updatedAt).toLocaleDateString('zh-CN')}
                </span>
              </p>
            </HoverCardContent>
          </HoverCard>
        ) : null}
        <p className="text-muted-foreground mt-2.5 flex items-center gap-3 text-xs tabular-nums">
          <span className="inline-flex items-center gap-1">
            <BookOpen className="size-3.5" />
            {course.sceneCount} 页
          </span>
          <span>{new Date(course.updatedAt).toLocaleDateString('zh-CN')}</span>
          {/* 作者真实姓名 — 右侧对齐 */}
          <span
            className="text-foreground/70 ml-auto inline-flex min-w-0 items-center gap-1"
            title={author}
          >
            <User className="size-3.5 shrink-0" />
            <span className="truncate">{author}</span>
          </span>
        </p>
      </Link>
    </div>
  );
}

/** The first slide's canvas when the serialized first scene is a usable slide. */
function firstSlideCanvas(course: ExploreCourse) {
  const content = course.firstScene?.content;
  if (!content || typeof content !== 'object' || !('type' in content)) return null;
  // The server already filtered to type === 'slide'; this re-checks the
  // deserialized shape before handing the canvas to the renderer.
  const tagged = content as { type: 'slide' | 'quiz' | 'interactive' | 'pbl' };
  return isSlideContent(tagged) ? tagged.canvas : null;
}
