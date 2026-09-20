'use client';

/**
 * /my-courses — the account's course shelf, split into three tabs:
 * 自制课程 (default), 收藏课程, 已学习课程. Login-gated per the product
 * requirement (401 → /login with a return path); the data itself comes from
 * the owner-scoped /api/my-courses aggregate (owned ∪ favorited ∪ learned).
 *
 * 自制课程 cards show the first page as the cover (explicit AI cover >
 * first-slide thumbnail > gradient fallback), the generation status
 * (已生成/生成中/失败), the generated page count, and the time. The edit
 * dialog can revise 标题/封面/介绍 — each field with an AI-generate button
 * (ai-meta for title/intro ≤200字, ai-cover for the cover image) — but only
 * once generation has finished: while the status is 生成中 the pencil stays
 * off the card (a mid-generation edit would race the generator's own writes).
 * 收藏 is for other people's courses: 自制课程 cards carry no star — the
 * favorite tab still shows one on anything listed there so no favorite can
 * strand without an un-favorite affordance.
 *
 * 自制课程 cards also carry a delete affordance (same 生成中 gate as the
 * pencil): deletion is the server's SOFT delete (a `stage_meta` tombstone —
 * the rows survive for the admin console; the shelf simply stops listing the
 * course), and it frees the account's course-creation quota headroom.
 *
 * The course-creation grant shapes the page: with the admin switch off the
 * 自制课程 tab drops to LAST (the landing tab becomes 收藏课程) and its
 * 去制作课程 affordance grays out; with the switch on a sky banner states the
 * remaining quota (course making burns a lot of AI resources); a full quota
 * keeps the tab in place but explains itself via the amber banner.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { BookOpen, Loader2, Pencil, Sparkles, Star, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { SiteHeader } from '@/components/site-header/site-header';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { coverGradient } from '@/lib/utils/cover-gradient';
import { deleteStageData } from '@/lib/utils/stage-storage';
import { useAuthModalStore } from '@/lib/store/auth-modal';
import { isSlideContent } from '@/lib/types/stage';
import { STAGE_NAME_MAX_LENGTH } from '@/lib/server/agent-runtime/stage-limits';
import type { CourseCreationGrant } from '@/lib/server/course-creation-gate';

const DESCRIPTION_MAX_LENGTH = 200;

type GenerationStatus = 'completed' | 'generating' | 'failed';

interface MyCourse {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  isOwned: boolean;
  isFavorite: boolean;
  status: GenerationStatus;
  sceneCount: number;
  coverUrl: string | null;
  lastLearnedAt?: string;
  learnCount?: number;
  /** Serialized first scene (slides only) — rendered as the card cover. */
  firstScene?: { content?: unknown };
}

type CourseTab = 'owned' | 'favorite' | 'learned';

/** The first slide's canvas when the serialized first scene is a usable slide. */
function firstSlideCanvas(course: MyCourse) {
  const content = course.firstScene?.content;
  if (!content || typeof content !== 'object' || !('type' in content)) return null;
  // The guard narrows a SceneType-tagged object; the raw JSONB already passed
  // the server-side type === 'slide' filter, this re-checks the deserialized
  // shape before handing the canvas to the renderer.
  const tagged = content as { type: 'slide' | 'quiz' | 'interactive' | 'pbl' };
  return isSlideContent(tagged) ? tagged.canvas : null;
}

function formatTime(epochOrIso: number | string): string {
  const date = typeof epochOrIso === 'number' ? new Date(epochOrIso) : new Date(epochOrIso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

const STATUS_LABEL: Record<GenerationStatus, string> = {
  completed: '已生成',
  generating: '生成中',
  failed: '失败',
};

function statusBadgeClass(status: GenerationStatus): string {
  if (status === 'completed') return 'bg-emerald-500/90 text-white';
  if (status === 'generating') return 'bg-sky-500/90 text-white';
  return 'bg-red-500/90 text-white';
}

export default function MyCoursesPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [courses, setCourses] = useState<MyCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CourseTab>('owned');
  const [editing, setEditing] = useState<MyCourse | null>(null);
  const [deleting, setDeleting] = useState<MyCourse | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Course-creation grant (admin switch + live quota) — explains in the
  // 自制课程 tab why making courses may be unavailable.
  const [creationGrant, setCreationGrant] = useState<CourseCreationGrant | null>(null);
  /** Guards the one-time landing-tab switch — later grant refreshes (e.g.
   * after a delete) must never yank the user off a tab they chose. */
  const landingTabResolved = useRef(false);

  const refreshCreationGrant = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me');
      const body = (await response.json().catch(() => null)) as {
        user?: { courseCreation?: CourseCreationGrant };
      } | null;
      setCreationGrant(body?.user?.courseCreation ?? null);
    } catch {
      // Leave the previous grant in place on a flaky probe.
    }
  }, []);

  const loadCourses = useCallback(async (): Promise<MyCourse[] | null> => {
    try {
      const response = await fetch('/api/my-courses');
      if (!response.ok) {
        setError('暂时无法加载课程列表');
        return null;
      }
      const data = (await response.json().catch(() => null)) as { courses?: MyCourse[] } | null;
      const list = data?.courses ?? [];
      setError(null);
      setCourses(list);
      return list;
    } catch {
      setError('网络错误，请稍后再试');
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Gate first: 401 → open the login modal in place (return path kept via
      // the modal's `next`); the auth-changed listener below re-runs the gate
      // the moment a session appears, so the page fills in without a reload.
      const auth = await fetch('/api/auth/me');
      if (cancelled) return;
      if (auth.status === 401) {
        useAuthModalStore.getState().openLogin('/my-courses');
        return;
      }
      setAuthChecked(true);
      await Promise.all([loadCourses(), refreshCreationGrant()]);
    })();
    const onAuthChanged = () => {
      void (async () => {
        const auth = await fetch('/api/auth/me');
        if (cancelled || auth.status === 401) return;
        setAuthChecked(true);
        await Promise.all([loadCourses(), refreshCreationGrant()]);
      })();
    };
    window.addEventListener('openmaic:auth-changed', onAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('openmaic:auth-changed', onAuthChanged);
    };
  }, [loadCourses, refreshCreationGrant]);

  const toggleFavorite = async (course: MyCourse) => {
    const next = !course.isFavorite;
    // Optimistic flip; revert on failure.
    setCourses((prev) =>
      prev ? prev.map((c) => (c.id === course.id ? { ...c, isFavorite: next } : c)) : prev,
    );
    try {
      const response = await fetch('/api/my-courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'favorite', stageId: course.id, favorite: next }),
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      setCourses((prev) =>
        prev ? prev.map((c) => (c.id === course.id ? { ...c, isFavorite: !next } : c)) : prev,
      );
      toast.error(next ? '收藏失败，请重试' : '取消收藏失败，请重试');
    }
  };

  const confirmDelete = async () => {
    const course = deleting;
    if (!course || deleteBusy) return;
    setDeleteBusy(true);
    // Optimistic removal, use-home-discovery style. Server-side this is the
    // tombstone soft delete — the rows survive for the admin console.
    setCourses((prev) => prev?.filter((c) => c.id !== course.id) ?? prev);
    try {
      await deleteStageData(course.id);
    } catch {
      toast.error('删除失败，请重试');
    } finally {
      setDeleteBusy(false);
      setDeleting(null);
      await loadCourses();
      // A deletion frees quota headroom — converge the banner with it.
      await refreshCreationGrant();
    }
  };

  // ── Tab splits (owned ∪ favorite ∪ learned arrive in one payload) ──
  const owned = useMemo(() => (courses ?? []).filter((c) => c.isOwned), [courses]);
  const favorite = useMemo(() => (courses ?? []).filter((c) => c.isFavorite), [courses]);
  const learned = useMemo(
    () =>
      (courses ?? [])
        .filter((c) => !!c.lastLearnedAt)
        .sort((a, b) => (a.lastLearnedAt! < b.lastLearnedAt! ? 1 : -1)),
    [courses],
  );

  // The grant's shape: switch off → 自制课程 is demoted to the last tab (the
  // account isn't a course maker); anything else keeps the default order.
  const creationForbidden =
    creationGrant !== null && !creationGrant.allowed && creationGrant.reason === 'forbidden';
  const creationBlocked = creationGrant !== null && !creationGrant.allowed;

  // One-time landing-tab pick: a demoted 自制课程 must not also be the tab the
  // page opens on — land on the new first tab (收藏课程) instead.
  useEffect(() => {
    if (landingTabResolved.current || creationGrant === null) return;
    landingTabResolved.current = true;
    if (creationForbidden && tab === 'owned') setTab('favorite');
    // `tab` deliberately excluded: this runs once, on the grant's arrival,
    // before the user has had a chance to pick a tab themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creationGrant, creationForbidden]);

  const tabItems: { value: CourseTab; label: string }[] = [
    { value: 'owned', label: `自制课程（${owned.length}）` },
    { value: 'favorite', label: `收藏课程（${favorite.length}）` },
    { value: 'learned', label: `已学习课程（${learned.length}）` },
  ];
  const orderedTabs = creationForbidden ? [tabItems[1], tabItems[2], tabItems[0]] : tabItems;

  // Why course making is unavailable, when it is (switch off / quota full).
  const creationBlockedMessage =
    creationGrant && !creationGrant.allowed
      ? creationGrant.reason === 'quota'
        ? `自制课程已达上限（${creationGrant.limit} 个），删除旧课程后可继续制作。`
        : '您暂时没有制作课程的权限，如果您认为自己可以制作课程，可以联系管理员。'
      : null;

  const visible = tab === 'owned' ? owned : tab === 'favorite' ? favorite : learned;

  const refreshAfterEdit = async () => {
    // Reload the shelf behind the dialog. Deliberately does NOT re-point
    // `editing` at the refreshed course object: a new object identity would
    // re-fire the dialog's reset effect and wipe the user's unsaved
    // 标题/介绍 edits (exactly what happened when AI 生成封面's refresh
    // landed mid-edit). The dialog owns its local state; the cover preview
    // is updated locally by the dialog itself.
    await loadCourses();
  };

  return (
    <div className="bg-gradient-to-b from-sky-50 via-white to-indigo-50 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950 min-h-[100dvh]">
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-28 md:px-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="bg-purple-100 dark:bg-purple-900/40 inline-flex size-11 items-center justify-center rounded-full text-purple-600 dark:text-purple-300">
            <BookOpen className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold">我的课程</h1>
            <p className="text-muted-foreground text-sm">自制、收藏与已学习的课程都在这里</p>
          </div>
        </div>

        {!authChecked ? (
          <div className="text-muted-foreground flex items-center gap-2 py-16 text-sm">
            <Loader2 className="size-4 animate-spin" /> 正在检查登录状态…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-4 py-16">
            <p className="text-muted-foreground text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadCourses()}>
              重试
            </Button>
          </div>
        ) : courses === null ? (
          <div className="text-muted-foreground flex items-center gap-2 py-16 text-sm">
            <Loader2 className="size-4 animate-spin" /> 正在加载课程…
          </div>
        ) : (
          <>
            {/* 配额说明 — switch on: state the headroom (course making burns a
                lot of AI resources); shown page-top, above the tabs. */}
            {creationGrant?.allowed && (
              <div className="mb-4 rounded-lg border border-sky-300/60 bg-sky-50 px-4 py-3 text-sm text-sky-700 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-400">
                您可以创建 {Math.max(0, creationGrant.limit - creationGrant.used)}{' '}
                个课程，因为每创建一次课程，会有大量的 AI
                资源消耗，所以需要谨慎使用，不随意生成。
              </div>
            )}

            <Tabs value={tab} onValueChange={(v) => setTab(v as CourseTab)}>
              <TabsList>
                {orderedTabs.map((item) => (
                  <TabsTrigger key={item.value} value={item.value}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {/* 制作权限说明 — admin switch off, or the live quota is full. */}
            {tab === 'owned' && creationBlockedMessage && (
              <div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-400">
                {creationBlockedMessage}
              </div>
            )}

            <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.length === 0 ? (
                <TabEmptyState tab={tab} createBlocked={creationBlocked} />
              ) : (
                visible.map((course) => (
                  <CourseCard
                    key={course.id}
                    course={course}
                    tab={tab}
                    onToggleFavorite={() => void toggleFavorite(course)}
                    onEdit={() => setEditing(course)}
                    onDelete={() => setDeleting(course)}
                  />
                ))
              )}
            </div>
          </>
        )}
      </main>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除课程「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后课程将从列表中移除（管理员仍可查看），不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteBusy}
              onClick={(event) => {
                // Keep the dialog open while the deletion runs; confirmDelete
                // closes it from its finally block.
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleteBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditCourseDialog
        course={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={() => void refreshAfterEdit()}
      />
    </div>
  );
}

// ─── Tab empty states ────────────────────────────────────────
function TabEmptyState({ tab, createBlocked }: { tab: CourseTab; createBlocked?: boolean }) {
  if (tab === 'owned') {
    return (
      <div className="text-muted-foreground col-span-full flex flex-col items-center gap-4 py-16 text-sm">
        <p>还没有自制课程，去生成第一门吧</p>
        {/* Blocked (switch off or quota full): gray and inert — the homepage's
            generate button would be gray anyway. Otherwise link to the maker. */}
        {createBlocked ? (
          <Button disabled>
            <Sparkles className="size-4" /> 去制作课程
          </Button>
        ) : (
          <Button asChild>
            <Link href="/">
              <Sparkles className="size-4" /> 去制作课程
            </Link>
          </Button>
        )}
      </div>
    );
  }
  return (
    <p className="text-muted-foreground col-span-full py-16 text-center text-sm">
      {tab === 'favorite'
        ? '还没有收藏课程，去首页推荐里逛逛吧'
        : '还没有学习记录，打开一门课程就开始学习啦'}
    </p>
  );
}

// ─── Course card ─────────────────────────────────────────────
function CourseCard({
  course,
  tab,
  onToggleFavorite,
  onEdit,
  onDelete,
}: {
  course: MyCourse;
  tab: CourseTab;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canvas = firstSlideCanvas(course);
  const time = tab === 'learned' && course.lastLearnedAt ? course.lastLearnedAt : course.updatedAt;

  return (
    <div className="group relative flex flex-col rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-900/80 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
      {/* Cover — AI cover > first-page thumbnail > gradient */}
      <Link
        href={`/classroom/${course.id}`}
        className="relative block aspect-video w-full overflow-hidden rounded-t-2xl bg-muted/40"
      >
        {course.coverUrl ? (
          <img src={course.coverUrl} alt={course.name} className="size-full object-cover" />
        ) : canvas ? (
          <div className="size-full p-0">
            <SlideThumbnail slide={canvas} viewportRatio={0.5625} />
          </div>
        ) : (
          <div
            className={cn(
              'flex size-full items-center justify-center bg-gradient-to-br',
              coverGradient(course.id),
            )}
          >
            <BookOpen className="size-7 text-white/90" />
          </div>
        )}

        {/* Generation status (owned courses) */}
        {course.isOwned && (
          <span
            className={cn(
              'absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm',
              statusBadgeClass(course.status),
            )}
          >
            {course.status === 'generating' && (
              <Loader2 className="size-2.5 animate-spin" aria-hidden />
            )}
            {STATUS_LABEL[course.status]}
          </span>
        )}
      </Link>

      {/* Favorite star — other people's courses only (自制课程 carry no star);
          the favorite tab always shows one so nothing strands favorited with
          no way back out. */}
      {(!course.isOwned || tab === 'favorite') && (
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-label={course.isFavorite ? '取消收藏' : '收藏课程'}
          className="absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm transition-colors hover:bg-black/50"
        >
          <Star
            className={cn(
              'size-4 transition-colors',
              course.isFavorite && 'fill-amber-400 text-amber-400',
            )}
          />
        </button>
      )}

      {/* Body */}
      <Link href={`/classroom/${course.id}`} className="flex flex-1 flex-col p-4">
        <h2 className="line-clamp-2 font-semibold leading-snug group-hover:text-purple-600 dark:group-hover:text-purple-400">
          {course.name}
        </h2>
        {course.description && (
          <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs leading-relaxed">
            {course.description}
          </p>
        )}
        <p className="text-muted-foreground mt-2.5 text-xs tabular-nums">
          已生成 {course.sceneCount} 页 · {formatTime(time)}
          {tab === 'learned' && course.learnCount && course.learnCount > 1
            ? ` · 学习 ${course.learnCount} 次`
            : ''}
        </p>
      </Link>

      {/* Owner actions (owners only, and only once generation has finished —
          an edit or delete mid-generation would race the generator's own
          stage writes). Delete is the server's tombstone soft delete: rows
          survive for the admin console and the quota slot frees up. */}
      {course.isOwned && course.status !== 'generating' && (
        <>
          <button
            type="button"
            onClick={onDelete}
            className="absolute bottom-3 right-12 inline-flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
            aria-label="删除课程"
            title="删除课程（管理员仍可查看）"
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="absolute bottom-3 right-3 inline-flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            aria-label="修改课程信息"
            title="修改标题 / 封面 / 介绍"
          >
            <Pencil className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

// ─── Edit dialog — 标题 / 封面 / 介绍, each AI-generable ──────
function EditCourseDialog({
  course,
  onOpenChange,
  onSaved,
}: {
  course: MyCourse | null;
  onOpenChange: (open: boolean) => void;
  /** Fired after any server-side change (保存 / cover actions) so the shelf
   * reloads behind the dialog. The dialog stays open for cover actions. */
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset the form whenever a different course opens the dialog.
  useEffect(() => {
    if (course) {
      setName(course.name);
      setDescription(course.description ?? '');
      setCoverUrl(course.coverUrl);
      setMetaLoading(false);
      setCoverLoading(false);
      setSaving(false);
    }
  }, [course]);

  if (!course) return null;

  const generateMeta = async () => {
    if (metaLoading) return;
    setMetaLoading(true);
    try {
      const response = await fetch('/api/my-courses/ai-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId: course.id }),
      });
      const data = (await response.json().catch(() => null)) as {
        title?: string;
        description?: string;
        error?: string;
      } | null;
      if (!response.ok || !data || (!data.title && !data.description)) {
        throw new Error(data?.error || '生成失败，请重试');
      }
      if (data.title) setName(data.title);
      if (data.description) setDescription(data.description);
      toast.success('已生成标题与介绍');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败，请重试');
    } finally {
      setMetaLoading(false);
    }
  };

  const generateCover = async () => {
    if (coverLoading) return;
    setCoverLoading(true);
    try {
      const response = await fetch('/api/my-courses/ai-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId: course.id }),
      });
      const data = (await response.json().catch(() => null)) as {
        coverUrl?: string;
        error?: string;
      } | null;
      if (!response.ok || !data?.coverUrl) {
        throw new Error(data?.error || '封面生成失败，请重试');
      }
      setCoverUrl(data.coverUrl);
      toast.success('封面已生成并保存');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '封面生成失败，请重试');
    } finally {
      setCoverLoading(false);
    }
  };

  const resetCover = async () => {
    if (coverLoading) return;
    setCoverLoading(true);
    try {
      const response = await fetch('/api/my-courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cover', stageId: course.id, coverUrl: null }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setCoverUrl(null);
      onSaved();
    } catch {
      toast.error('恢复默认封面失败，请重试');
    } finally {
      setCoverLoading(false);
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      nameRef.current?.focus();
      toast.error('标题不能为空');
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/stages/${course.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, description: description.trim() || null }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || '保存失败，请重试');
      }
      toast.success('已保存');
      // Close FIRST, then refresh the shelf — the refresh must never re-point
      // `editing` after the close (that would re-open the dialog).
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!course} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>修改课程信息</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* ── 标题 ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">标题</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void generateMeta()}
                disabled={metaLoading}
              >
                {metaLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
                AI 生成
              </Button>
            </div>
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={STAGE_NAME_MAX_LENGTH}
              placeholder="课程标题"
            />
          </div>

          {/* ── 介绍 ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">介绍</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {description.length}/{DESCRIPTION_MAX_LENGTH}
              </span>
            </div>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX_LENGTH))}
              maxLength={DESCRIPTION_MAX_LENGTH}
              rows={4}
              placeholder="课程介绍（200 字以内）"
              className="resize-none"
            />
          </div>

          {/* ── 封面 ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">封面</span>
              <div className="flex items-center gap-1.5">
                {coverUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void resetCover()}
                    disabled={coverLoading}
                  >
                    恢复默认
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void generateCover()}
                  disabled={coverLoading}
                >
                  {coverLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="size-3.5" />
                  )}
                  AI 生成封面
                </Button>
              </div>
            </div>
            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/40 bg-muted/40">
              {coverUrl ? (
                <img src={coverUrl} alt="课程封面" className="size-full object-cover" />
              ) : (
                <div className="text-muted-foreground/60 flex size-full flex-col items-center justify-center gap-1.5 text-xs">
                  <BookOpen className="size-6" />
                  <span>默认使用课程第一页作为封面</span>
                </div>
              )}
              {coverLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 正在生成封面…
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving || metaLoading || coverLoading}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
