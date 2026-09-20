'use client';

/**
 * /admin/users — platform end-user account management (P0): search, create,
 * edit (真实姓名/AI 昵称/status/password), delete. No role concept; 工号
 * (username) is the immutable account key. Avatars stay user-managed in the
 * product (/profile, 首页 GreetingBar) — shown read-only here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { Badge } from '@/components/ui/badge';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  nickname: string | null;
  status: 'active' | 'disabled';
  can_create_courses: boolean;
  course_creation_quota: number;
  created_at: string;
  updated_at: string;
}

interface UsersResponse {
  users: UserRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface EditorState {
  open: boolean;
  original: UserRow | null;
  username: string;
  password: string;
  displayName: string;
  nickname: string;
  status: 'active' | 'disabled';
  canCreateCourses: boolean;
  /** Text-typed for the number input; parsed + range-checked on save. */
  courseCreationQuota: string;
}

// 新建用户：默认密码 abc123 预填（唯一预填项），工号/真实姓名留空。
// 制作权限默认关、上限默认 3 — 与 user_accounts 的列默认一致。
const DEFAULT_NEW_USER_PASSWORD = 'abc123';
const DEFAULT_COURSE_CREATION_QUOTA = 3;

const EMPTY_EDITOR: EditorState = {
  open: false,
  original: null,
  username: '',
  password: DEFAULT_NEW_USER_PASSWORD,
  displayName: '',
  nickname: '',
  status: 'active',
  canCreateCourses: false,
  courseCreationQuota: String(DEFAULT_COURSE_CREATION_QUOTA),
};

const PAGE_SIZE = 20;

export default function AdminUsersPage() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);

  const load = useCallback(async (searchQuery: string, pageNumber: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(pageNumber), pageSize: String(PAGE_SIZE) });
      if (searchQuery) params.set('query', searchQuery);
      const response = await fetch(`/api/admin/users?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || '加载失败');
        return;
      }
      setData(body as UsersResponse);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(query, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, page]);

  async function handleSave() {
    const quota = Number.parseInt(editor.courseCreationQuota, 10);
    if (!Number.isInteger(quota) || quota < 0 || quota > 999) {
      toast.error('制作课程上限需为 0-999 的整数');
      return;
    }
    setSaving(true);
    try {
      const isEdit = !!editor.original;
      const response = await fetch(
        isEdit ? `/api/admin/users/${editor.original!.id}` : '/api/admin/users',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
          body: JSON.stringify(
            isEdit
              ? {
                  displayName: editor.displayName,
                  nickname: editor.nickname,
                  status: editor.status,
                  canCreateCourses: editor.canCreateCourses,
                  courseCreationQuota: quota,
                  ...(editor.password === '' ? {} : { password: editor.password }),
                }
              : {
                  username: editor.username.trim(),
                  password: editor.password,
                  displayName: editor.displayName,
                  status: editor.status,
                  canCreateCourses: editor.canCreateCourses,
                  courseCreationQuota: quota,
                },
          ),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '保存失败');
        return;
      }
      toast.success(isEdit ? '已保存' : '已创建');
      setEditor(EMPTY_EDITOR);
      await load(query, page);
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const response = await fetch(`/api/admin/users/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { 'x-admin-request': '1' },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || '删除失败');
      return;
    }
    toast.success(`已删除 ${deleteTarget.username}`);
    setDeleteTarget(null);
    await load(query, page);
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">用户管理</h1>
          <p className="text-muted-foreground text-sm">平台终端账号</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
            <Input
              className="w-56 pl-8"
              placeholder="搜索工号 / 真实姓名"
              value={query}
              onChange={(event) => {
                setPage(1);
                void load(event.target.value, 1);
                setQuery(event.target.value);
              }}
            />
          </div>
          <Button size="sm" onClick={() => setEditor({ ...EMPTY_EDITOR, open: true })}>
            <Plus className="size-4" />
            新建用户
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工号</TableHead>
              <TableHead>头像</TableHead>
              <TableHead>真实姓名</TableHead>
              <TableHead>AI 昵称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>制作权限</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !data ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground py-10 text-center">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : data?.users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground py-10 text-center text-sm">
                  暂无用户
                </TableCell>
              </TableRow>
            ) : (
              data?.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>
                    <span className="inline-flex size-7 items-center justify-center overflow-hidden rounded-full bg-muted">
                      <AvatarDisplay
                        src={
                          user.avatar_url ??
                          (user.display_name || user.username).slice(0, 1).toUpperCase()
                        }
                        alt={user.username}
                      />
                    </span>
                  </TableCell>
                  <TableCell>{user.display_name ?? '—'}</TableCell>
                  <TableCell>{user.nickname ?? '—'}</TableCell>
                  <TableCell>
                    {user.status === 'active' ? (
                      <Badge variant="secondary">正常</Badge>
                    ) : (
                      <Badge variant="destructive">停用</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {user.can_create_courses ? (
                      <Badge variant="outline" className="gap-1 text-emerald-600">
                        可制作 · {user.course_creation_quota}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">禁止</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(user.created_at).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditor({
                            open: true,
                            original: user,
                            username: user.username,
                            password: '',
                            displayName: user.display_name ?? '',
                            nickname: user.nickname ?? '',
                            status: user.status,
                            canCreateCourses: user.can_create_courses,
                            courseCreationQuota: String(user.course_creation_quota),
                          })
                        }
                      >
                        <Pencil className="size-4" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(user)}
                      >
                        <Trash2 className="size-4" />
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-muted-foreground flex items-center justify-between text-sm">
        <span>
          共 {data?.total ?? 0} 人 · 第 {page} / {totalPages} 页
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      </div>

      <Dialog open={editor.open} onOpenChange={(open) => !open && setEditor(EMPTY_EDITOR)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editor.original ? '编辑用户' : '新建用户'}</DialogTitle>
            <DialogDescription>
              {editor.original ? `正在编辑 ${editor.original.username}` : '创建平台终端账号'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-username">工号</Label>
              <Input
                id="user-username"
                value={editor.username}
                onChange={(event) =>
                  setEditor((state) => ({ ...state, username: event.target.value }))
                }
                disabled={!!editor.original}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-display-name">真实姓名</Label>
              <Input
                id="user-display-name"
                value={editor.displayName}
                onChange={(event) =>
                  setEditor((state) => ({ ...state, displayName: event.target.value }))
                }
              />
            </div>
            {editor.original ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="user-nickname">
                  AI 昵称
                  <span className="text-muted-foreground text-xs">（最多 20 字，留空则清除）</span>
                </Label>
                <Input
                  id="user-nickname"
                  value={editor.nickname}
                  maxLength={20}
                  onChange={(event) =>
                    setEditor((state) => ({ ...state, nickname: event.target.value }))
                  }
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-password">
                密码
                {editor.original ? (
                  <span className="text-muted-foreground text-xs">（留空不修改）</span>
                ) : null}
              </Label>
              <Input
                id="user-password"
                type="password"
                value={editor.password}
                onChange={(event) =>
                  setEditor((state) => ({ ...state, password: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>状态</Label>
              <Select
                value={editor.status}
                onValueChange={(value) =>
                  setEditor((state) => ({ ...state, status: value as 'active' | 'disabled' }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">正常</SelectItem>
                  <SelectItem value="disabled">停用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-can-create-courses">允许制作课程</Label>
              <div className="flex items-center gap-3">
                <Switch
                  id="user-can-create-courses"
                  checked={editor.canCreateCourses}
                  onCheckedChange={(checked) =>
                    setEditor((state) => ({ ...state, canCreateCourses: checked }))
                  }
                />
                <span className="text-muted-foreground text-xs">
                  关闭时，该用户无法在首页新建课程（默认关闭）
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-course-creation-quota">制作课程上限</Label>
              <Input
                id="user-course-creation-quota"
                type="number"
                min={0}
                max={999}
                value={editor.courseCreationQuota}
                onChange={(event) =>
                  setEditor((state) => ({ ...state, courseCreationQuota: event.target.value }))
                }
              />
              <span className="text-muted-foreground text-xs">
                该用户名下未删除课程的数量上限（默认 3，删除课程会释放名额）
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(EMPTY_EDITOR)}>
              取消
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={
                saving || !editor.username.trim() || (!editor.original && editor.password === '')
              }
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除用户 {deleteTarget?.username}？</AlertDialogTitle>
            <AlertDialogDescription>
              该操作立即生效且写入审计日志；账号无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
