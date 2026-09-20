'use client';

/**
 * /admin/courses — cross-owner course administration.
 *
 * List + filter + 推荐 (publication = shelf visibility) + 推荐到首页 (the
 * homepage's curated grid, a subset of the shelf) + category/tag assignment,
 * plus the console's full course lifecycle: 编辑 (标题/简述/封面/作者, each
 * AI-generable), 打开 (a signed preview cookie opens the real /classroom/:id
 * as the course's owner — editable, and the visit is never recorded into any
 * user's learning history), and 完整删除 (hard delete of rows, asset
 * references and on-disk media, behind a confirmation). Courses render as a
 * 3-up card grid (cover-forward, like the product shelf); each card's actions
 * live in one dropdown menu to keep the cards scannable.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  BookOpen,
  ExternalLink,
  Home,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Star,
  StarOff,
  Tags,
  Trash2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { coverGradient } from '@/lib/utils/cover-gradient';

interface CourseRow {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
  scene_count: string;
  publish_status: 'draft' | 'published' | 'archived';
  /** 推荐到首页 — the homepage grid only picks featured published courses. */
  featured: boolean;
  category_id: string | null;
  category_name: string | null;
  cover_url: string | null;
  generation_status: 'completed' | 'generating' | 'failed';
  tags: { id: string; name: string }[];
  /** 用户主动软删除的时间（墓碑）；null = 未删除。The rows survive by design. */
  user_deleted_at: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface TagRow {
  id: string;
  name: string;
}

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string | null;
  nickname: string | null;
}

interface CoursesResponse {
  courses: CourseRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** 120 / 200 — mirrors the storage-domain stage limits the API enforces. */
const STAGE_NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 200;

const PUBLISH_LABELS: Record<CourseRow['publish_status'], string> = {
  draft: '未推荐',
  published: '已推荐',
  archived: '已归档',
};

const PUBLISH_BADGE_VARIANTS: Record<
  CourseRow['publish_status'],
  'secondary' | 'default' | 'outline'
> = {
  draft: 'secondary',
  published: 'default',
  archived: 'outline',
};

const GENERATION_LABELS: Record<CourseRow['generation_status'], string> = {
  completed: '已完成',
  generating: '生成中',
  failed: '生成失败',
};

/** Same color language as the my-courses shelf badges, softened for a table. */
function generationBadgeClass(status: CourseRow['generation_status']): string {
  if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (status === 'generating') return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  return 'border-red-500/30 bg-red-500/10 text-red-600';
}

function userLabel(user: AdminUserRow): string {
  return user.display_name || user.nickname || user.username;
}

export default function AdminCoursesPage() {
  const [data, setData] = useState<CoursesResponse | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searchText, setSearchText] = useState('');
  const [status, setStatus] = useState('all');
  const [categoryId, setCategoryId] = useState('all');
  const [tagId, setTagId] = useState('all');
  const [page, setPage] = useState(1);
  const [busyStageId, setBusyStageId] = useState('');
  /** Tag-assignment dialog: the course being tagged + its working selection. */
  const [tagAssign, setTagAssign] = useState<{ course: CourseRow; selected: string[] } | null>(
    null,
  );
  /** Edit dialog: the course whose 基本信息 (标题/简述/封面/作者) is being edited. */
  const [editing, setEditing] = useState<CourseRow | null>(null);
  /** Delete confirmation: the course about to be hard-deleted with its media. */
  const [deleteTarget, setDeleteTarget] = useState<CourseRow | null>(null);
  /** 生成过程 drill-down: the course whose generation call timeline is shown. */
  const [traceTarget, setTraceTarget] = useState<CourseRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 18 = three full card rows on wide screens (the grid is 3-up at xl).
      const params = new URLSearchParams({ page: String(page), pageSize: '18' });
      if (searchText) params.set('query', searchText);
      if (status !== 'all') params.set('status', status);
      if (categoryId !== 'all') params.set('categoryId', categoryId);
      if (tagId !== 'all') params.set('tagId', tagId);
      const response = await fetch(`/api/admin/courses?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '加载失败');
        return;
      }
      setData(body as CoursesResponse);
    } catch {
      toast.error('网络错误');
    } finally {
      setLoading(false);
    }
  }, [page, searchText, status, categoryId, tagId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const [categoriesResponse, tagsResponse] = await Promise.all([
          fetch('/api/admin/categories'),
          fetch('/api/admin/tags'),
        ]);
        const categoriesBody = await categoriesResponse.json().catch(() => ({}));
        const tagsBody = await tagsResponse.json().catch(() => ({}));
        if (categoriesResponse.ok) setCategories(categoriesBody.categories ?? []);
        if (tagsResponse.ok) setTags(tagsBody.tags ?? []);
      } catch {
        // Non-critical: filter/assign degrade to unavailable.
      }
    })();
  }, []);

  async function patchCourse(
    stageId: string,
    action: string,
    extra?: { categoryId?: string; tagIds?: string[]; coverUrl?: string | null },
  ) {
    setBusyStageId(stageId);
    try {
      const response = await fetch('/api/admin/courses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ stageId, action, ...extra }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '操作失败');
        return false;
      }
      return true;
    } catch {
      toast.error('网络错误');
      return false;
    } finally {
      setBusyStageId('');
    }
  }

  const saveTags = async () => {
    if (!tagAssign) return;
    if (await patchCourse(tagAssign.course.id, 'setTags', { tagIds: tagAssign.selected })) {
      toast.success('标签已保存');
    }
    setTagAssign(null);
  };

  /**
   * 打开: mint the signed preview cookie, then open the real classroom page
   * in a new tab. There the admin edits as the course's owner, and the
   * learning touch is a server-side no-op — the visit lands in nobody's
   * 已学习 history.
   */
  async function openCourse(course: CourseRow) {
    const ok = await patchCourse(course.id, 'beginPreview');
    if (ok) window.open(`/classroom/${course.id}`, '_blank', 'noopener');
  }

  async function deleteCourse(course: CourseRow) {
    setBusyStageId(course.id);
    try {
      const response = await fetch('/api/admin/courses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ stageId: course.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '删除失败');
        return;
      }
      toast.success(`已删除「${course.name}」`);
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setBusyStageId('');
      setDeleteTarget(null);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">课程管理</h1>
          <p className="text-muted-foreground text-sm">
            跨所有者的课程管理：推荐与上首页、分类标签、信息编辑、预览与完整删除
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">筛选</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="flex gap-2">
            <Input
              className="w-56"
              placeholder="按课程名搜索…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setPage(1);
                  setSearchText(query.trim());
                }
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPage(1);
                setSearchText(query.trim());
              }}
            >
              搜索
            </Button>
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              setPage(1);
              setStatus(value);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部推荐状态</SelectItem>
              <SelectItem value="published">已推荐</SelectItem>
              <SelectItem value="draft">未推荐</SelectItem>
              <SelectItem value="archived">已归档</SelectItem>
              <SelectItem value="userDeleted">用户已删除</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={categoryId}
            onValueChange={(value) => {
              setPage(1);
              setCategoryId(value);
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={tagId}
            onValueChange={(value) => {
              setPage(1);
              setTagId(value);
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部标签</SelectItem>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground ml-auto text-sm">
            共 {data ? data.total : '…'} 门课程
          </span>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {loading && !data ? (
          <div className="text-muted-foreground flex justify-center py-16">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : !data || data.courses.length === 0 ? (
          <p className="text-muted-foreground py-10 text-center text-sm">暂无课程</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.courses.map((course) => (
                <CourseCard
                  key={course.id}
                  course={course}
                  categories={categories}
                  busy={busyStageId === course.id}
                  onOpen={() => void openCourse(course)}
                  onEdit={() => setEditing(course)}
                  onTrace={() => setTraceTarget(course)}
                  onTags={() =>
                    setTagAssign({ course, selected: course.tags.map((tag) => tag.id) })
                  }
                  onCuration={(action) => void patchCourse(course.id, action).then(() => load())}
                  onCategory={(value) =>
                    void patchCourse(
                      course.id,
                      value === 'none' ? 'clearCategory' : 'setCategory',
                      value === 'none' ? undefined : { categoryId: value },
                    ).then(() => load())
                  }
                  onDelete={() => setDeleteTarget(course)}
                />
              ))}
            </div>

            {data.total > data.pageSize ? (
              <div className="flex items-center justify-end gap-3 pt-2">
                <span className="text-muted-foreground text-sm">
                  第 {data.page} / {totalPages} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑课程信息</DialogTitle>
            <DialogDescription>标题、简述、封面与作者；保存后立即生效</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditCourseForm
              key={editing.id}
              course={editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void load();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认完整删除课程？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                将永久删除「{deleteTarget?.name}」及其 {deleteTarget?.scene_count}{' '}
                个场景，包括全部媒体文件（封面、生成图片、音频）、推荐/分类/标签与学习记录。
                <br />
                此操作不可恢复。
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyStageId === deleteTarget?.id}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busyStageId === deleteTarget?.id}
              onClick={(event) => {
                // Keep the dialog open while the request runs — the default
                // close-on-click would let a failed delete look completed.
                event.preventDefault();
                if (deleteTarget) void deleteCourse(deleteTarget);
              }}
            >
              {busyStageId === deleteTarget?.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={tagAssign !== null} onOpenChange={(open) => !open && setTagAssign(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>课程标签</DialogTitle>
            <DialogDescription>
              {tagAssign ? `为「${tagAssign.course.name}」勾选标签，保存后生效` : ''}
            </DialogDescription>
          </DialogHeader>
          {tagAssign ? (
            tags.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                还没有可用标签，先到{' '}
                <Link href="/admin/tags" className="text-foreground underline">
                  标签管理
                </Link>{' '}
                创建
              </p>
            ) : (
              <>
                <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                  {tags.map((tag) => {
                    const checked = tagAssign.selected.includes(tag.id);
                    return (
                      <label
                        key={tag.id}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            setTagAssign({
                              course: tagAssign.course,
                              selected: checked
                                ? tagAssign.selected.filter((id) => id !== tag.id)
                                : [...tagAssign.selected, tag.id],
                            })
                          }
                        />
                        <span className="flex-1 truncate">{tag.name}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTagAssign(null)}
                    disabled={busyStageId === tagAssign.course.id}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void saveTags()}
                    disabled={busyStageId === tagAssign.course.id}
                  >
                    {busyStageId === tagAssign.course.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    保存
                  </Button>
                </div>
              </>
            )
          ) : null}
        </DialogContent>
      </Dialog>

      <GenerationTraceDialog course={traceTarget} onClose={() => setTraceTarget(null)} />
    </div>
  );
}

// ─── Course card — one course in the 3-up grid ─────────────────────────────
function CourseCard({
  course,
  categories,
  busy,
  onOpen,
  onEdit,
  onTrace,
  onTags,
  onCuration,
  onCategory,
  onDelete,
}: {
  course: CourseRow;
  categories: CategoryRow[];
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  /** 生成过程 — the generation call timeline drill-down. */
  onTrace: () => void;
  onTags: () => void;
  /** 推荐/首页 curation — the verb is pre-computed by the caller. */
  onCuration: (action: 'feature' | 'unfeature' | 'publish' | 'draft') => void;
  /** 'none' clears the category; anything else assigns it. */
  onCategory: (value: string) => void;
  onDelete: () => void;
}) {
  return (
    <Card className="flex flex-col overflow-hidden py-0 gap-0">
      {/* Cover — gradient fallback; curation badges top-left, action menu top-right */}
      <div
        className="relative aspect-video w-full shrink-0"
        style={{ background: coverGradient(course.id) }}
      >
        {course.cover_url ? (
          <img src={course.cover_url} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <BookOpen className="text-muted-foreground absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-1/2 opacity-60" />
        )}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          <Badge variant={PUBLISH_BADGE_VARIANTS[course.publish_status]} className="shadow-sm">
            {PUBLISH_LABELS[course.publish_status]}
          </Badge>
          {course.featured ? (
            <Badge
              variant="outline"
              className="gap-1 border-amber-400/60 bg-amber-500/90 text-[10px] text-white shadow-sm backdrop-blur"
            >
              <Home className="size-3" />
              已上首页
            </Badge>
          ) : null}
          {course.user_deleted_at ? (
            <Badge
              variant="outline"
              className="gap-1 border-slate-400/60 bg-slate-600/90 text-[10px] text-white shadow-sm backdrop-blur"
            >
              <Trash2 className="size-3" />
              用户已删除
            </Badge>
          ) : null}
        </div>
        <div className="absolute top-1.5 right-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`操作：${course.name}`}
                disabled={busy}
                className="bg-background/70 hover:bg-background/90 shadow-sm backdrop-blur"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <MoreHorizontal className="size-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem className="gap-2" onClick={onOpen}>
                <ExternalLink className="size-4" />
                打开课程
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={onEdit}>
                <Pencil className="size-4" />
                编辑信息
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={onTags}>
                <Tags className="size-4" />
                设置标签
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={onTrace}>
                <Activity className="size-4" />
                生成过程
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2"
                onClick={() => onCuration(course.featured ? 'unfeature' : 'feature')}
              >
                <Home className="size-4" />
                {course.featured ? '从首页撤下' : '推荐到首页'}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2"
                onClick={() =>
                  onCuration(course.publish_status === 'published' ? 'draft' : 'publish')
                }
              >
                {course.publish_status === 'published' ? (
                  <StarOff className="size-4" />
                ) : (
                  <Star className="size-4" />
                )}
                {course.publish_status === 'published' ? '取消推荐' : '推荐'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-destructive focus:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="size-4" />
                删除课程
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
            title={`${course.name}（点击打开课程）`}
            onClick={onOpen}
          >
            {course.name}
          </button>
          <Badge
            variant="outline"
            className={`shrink-0 gap-1 text-[10px] ${generationBadgeClass(course.generation_status)}`}
          >
            {course.generation_status === 'generating' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            {GENERATION_LABELS[course.generation_status]}
          </Badge>
        </div>

        {course.description ? (
          <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
            {course.description}
          </p>
        ) : (
          <p className="text-muted-foreground/60 line-clamp-2 text-xs">（无简述）</p>
        )}

        {course.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {course.tags.map((tag) => (
              <Badge key={tag.id} variant="outline" className="text-[10px]">
                {tag.name}
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="border-border/60 mt-auto flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium" title={course.owner_id ?? undefined}>
              {course.owner_name ?? '匿名用户'}
            </span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {course.scene_count} 场景
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Select value={course.category_id ?? 'none'} onValueChange={onCategory} disabled={busy}>
              <SelectTrigger className="h-7 flex-1 text-xs">
                <SelectValue placeholder="未分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未分类</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              className="text-muted-foreground shrink-0 text-[11px]"
              title={new Date(course.updated_at).toLocaleString('zh-CN')}
            >
              {new Date(course.updated_at).toLocaleDateString('zh-CN')}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── 生成过程 — the course's generation-call timeline (generation_trace) ──
const TRACE_STEP_LABELS: Record<string, string> = {
  'scene-content': '内容生成',
  'scene-actions': '动作生成',
  tts: '语音合成',
  image: '图片生成',
  video: '视频生成',
};

/** Locale-neutral duration: 823ms / 12.4s / 4m05s. */
function formatTraceMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}

interface TraceRow {
  id: number;
  createdAt: string;
  step: string;
  page: number | null;
  providerId: string | null;
  modelId: string | null;
  durationMs: number;
  status: string;
  errorCode: string | null;
  errorSnippet: string | null;
}

interface TraceStepSummary {
  step: string;
  calls: number;
  errors: number;
  avgMs: number;
  totalMs: number;
}

interface TraceResponse {
  success: boolean;
  stageId: string;
  rows: TraceRow[];
  summary: {
    steps: TraceStepSummary[];
    totalCalls: number;
    totalErrors: number;
    firstCallAt: string | null;
    lastCallAt: string | null;
  };
}

function GenerationTraceDialog({
  course,
  onClose,
}: {
  course: CourseRow | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<TraceResponse | null>(null);

  // Refetch on every open — a course inspected mid-generation shows fresh rows.
  useEffect(() => {
    if (!course) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/admin/generation-trace?stageId=${encodeURIComponent(course.id)}`,
        );
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error || '加载失败');
          return;
        }
        setData(body as TraceResponse);
      } catch {
        if (!cancelled) setError('网络错误');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [course]);

  const maxStepMs = data ? Math.max(1, ...data.summary.steps.map((s) => s.totalMs)) : 1;

  const formatSpan = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';

  return (
    <Dialog open={course !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-4" />
            生成过程{course ? `：${course.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            每次生成调用的耗时与成败（内容/动作/语音/图片/视频，记录保留约 30 天）
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        ) : error ? (
          <p className="text-destructive py-8 text-center text-sm">{error}</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            暂无生成调用记录（记录已过期、课程在本次部署前生成，或正在生成中可稍后再看）
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border p-2.5">
                <p className="text-muted-foreground text-[11px]">总调用</p>
                <p className="tabular-nums text-lg font-semibold">{data.summary.totalCalls}</p>
              </div>
              <div className="rounded-lg border p-2.5">
                <p className="text-muted-foreground text-[11px]">失败次数</p>
                <p
                  className={`tabular-nums text-lg font-semibold ${data.summary.totalErrors > 0 ? 'text-destructive' : ''}`}
                >
                  {data.summary.totalErrors}
                </p>
              </div>
              <div className="rounded-lg border p-2.5">
                <p className="text-muted-foreground text-[11px]">首次调用</p>
                <p className="text-xs leading-5 font-medium">
                  {formatSpan(data.summary.firstCallAt)}
                </p>
              </div>
              <div className="rounded-lg border p-2.5">
                <p className="text-muted-foreground text-[11px]">最近调用</p>
                <p className="text-xs leading-5 font-medium">
                  {formatSpan(data.summary.lastCallAt)}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              {data.summary.steps.map((step) => (
                <div key={step.step}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="shrink-0 font-medium">
                      {TRACE_STEP_LABELS[step.step] ?? step.step}
                      {step.errors > 0 ? (
                        <span className="text-destructive">（失败 {step.errors}）</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {step.calls} 次 · 平均 {formatTraceMs(step.avgMs)} · 合计{' '}
                      {formatTraceMs(step.totalMs)}
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${(step.totalMs / maxStepMs) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>步骤</TableHead>
                  <TableHead>页</TableHead>
                  <TableHead className="hidden sm:table-cell">模型</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular-nums whitespace-nowrap text-xs">
                      {new Date(row.createdAt).toLocaleString('zh-CN', {
                        hour12: false,
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </TableCell>
                    <TableCell className="text-xs">
                      {TRACE_STEP_LABELS[row.step] ?? row.step}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs">{row.page ?? '—'}</TableCell>
                    <TableCell
                      className="hidden max-w-40 truncate font-mono text-[11px] sm:table-cell"
                      title={row.modelId ? `${row.providerId}:${row.modelId}` : undefined}
                    >
                      {row.modelId ? `${row.providerId}:${row.modelId}` : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs">
                      {formatTraceMs(row.durationMs)}
                    </TableCell>
                    <TableCell
                      className={`text-xs ${row.status === 'ok' ? 'text-emerald-600' : 'text-destructive'}`}
                      title={row.errorSnippet ?? undefined}
                    >
                      {row.status === 'ok' ? '成功' : '失败'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit form — 标题 / 简述 / 封面（各可 AI 生成）+ 作者转移 ────────────
function EditCourseForm({
  course,
  onCancel,
  onSaved,
}: {
  course: CourseRow;
  /** Fired when the dialog closes without saving. */
  onCancel: () => void;
  /** Fired after a successful save (dialog closes, list reloads). */
  onSaved: () => void;
}) {
  const [name, setName] = useState(course.name);
  const [description, setDescription] = useState(course.description ?? '');
  const [coverUrl, setCoverUrl] = useState(course.cover_url);
  const [metaLoading, setMetaLoading] = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 'keep' retains the current owner; 'user:<uuid>' transfers authorship. */
  const [ownerValue, setOwnerValue] = useState('keep');
  const [userQuery, setUserQuery] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // Candidate authors: searchable, capped at the admin users API's page size.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setUsersLoading(true);
        try {
          const params = new URLSearchParams({ pageSize: '100' });
          if (userQuery.trim()) params.set('query', userQuery.trim());
          const response = await fetch(`/api/admin/users?${params}`);
          const body = await response.json().catch(() => ({}));
          if (!cancelled && response.ok) setUsers(body.users ?? []);
        } catch {
          // Non-critical: the author dropdown degrades to empty.
        } finally {
          if (!cancelled) setUsersLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userQuery]);

  const generateMeta = async () => {
    if (metaLoading) return;
    setMetaLoading(true);
    try {
      const response = await fetch('/api/admin/courses/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ stageId: course.id, kind: 'meta' }),
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
      toast.success('已生成标题与简述');
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
      const response = await fetch('/api/admin/courses/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ stageId: course.id, kind: 'cover' }),
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
      const response = await fetch('/api/admin/courses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ stageId: course.id, action: 'setCover', coverUrl: null }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setCoverUrl(null);
      toast.success('已恢复默认封面');
    } catch {
      toast.error('恢复默认封面失败，请重试');
    } finally {
      setCoverLoading(false);
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('标题不能为空');
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch('/api/admin/courses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({
          stageId: course.id,
          action: 'updateInfo',
          name: trimmedName,
          description: description.trim() || null,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || '保存失败，请重试');
      }
      if (ownerValue !== 'keep') {
        const ownerResponse = await fetch('/api/admin/courses', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
          body: JSON.stringify({
            stageId: course.id,
            action: 'setOwner',
            ownerUserId: ownerValue,
          }),
        });
        if (!ownerResponse.ok) {
          const data = (await ownerResponse.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || '作者修改失败，请重试');
        }
      }
      toast.success('已保存');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
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
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={STAGE_NAME_MAX_LENGTH}
          placeholder="课程标题"
        />
      </div>

      {/* ── 简述 ── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium">简述</span>
          <span className="text-muted-foreground text-[11px] tabular-nums">
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
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <Loader2 className="size-4 animate-spin" /> 正在生成封面…
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── 作者 ── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium">作者</span>
          <span className="text-muted-foreground text-[11px]">
            当前：{course.owner_name ?? '匿名用户'}
          </span>
        </div>
        <Input
          className="mb-2"
          placeholder="搜索用户（工号 / 姓名）…"
          value={userQuery}
          onChange={(e) => setUserQuery(e.target.value)}
        />
        <Select value={ownerValue} onValueChange={setOwnerValue}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="保持当前作者" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="keep">保持当前作者</SelectItem>
            {users.map((user) => (
              <SelectItem key={user.id} value={`user:${user.id}`}>
                {userLabel(user)}
                {userLabel(user) !== user.username ? `（${user.username}）` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {usersLoading ? (
          <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin" /> 正在加载用户…
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={saving || metaLoading || coverLoading}
        >
          取消
        </Button>
        <Button onClick={() => void save()} disabled={saving || metaLoading || coverLoading}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          保存
        </Button>
      </DialogFooter>
    </div>
  );
}
