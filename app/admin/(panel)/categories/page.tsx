'use client';

/**
 * /admin/categories — course category management (P1).
 *
 * Full CRUD over /api/admin/categories: tree display (children indented under
 * their parent), create/rename/reparent/reorder, delete with a course-count
 * warning. Deleting a category only uncategorizes its courses — the courses
 * themselves stay, so the confirm copy says so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: string;
  course_count: string;
}

type Editor = { mode: 'create' } | { mode: 'edit'; row: CategoryRow } | null;

/** Rows laid out as a display tree: children directly under their parent. */
function layoutTree(rows: CategoryRow[]): { row: CategoryRow; depth: number }[] {
  const byParent = new Map<string | null, CategoryRow[]>();
  for (const row of rows) {
    const key = row.parent_id ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const ordered: { row: CategoryRow; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const row of byParent.get(parent) ?? []) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      ordered.push({ row, depth });
      visit(row.id, depth + 1);
    }
  };
  visit(null, 0);
  // Rows whose parent row is missing (or forms a loop) still render.
  for (const row of rows) {
    if (!visited.has(row.id)) ordered.push({ row, depth: 0 });
  }
  return ordered;
}

/** The row itself plus everything below it — excluded as reparent targets. */
function descendantIds(rows: CategoryRow[], id: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parent_id) {
      childrenOf.set(row.parent_id, [...(childrenOf.get(row.parent_id) ?? []), row.id]);
    }
  }
  const blocked = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (!blocked.has(child)) {
        blocked.add(child);
        queue.push(child);
      }
    }
  }
  return blocked;
}

export default function AdminCategoriesPage() {
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [formName, setFormName] = useState('');
  const [formParentId, setFormParentId] = useState('none');
  const [formSortOrder, setFormSortOrder] = useState('0');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/categories');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '加载失败');
        return;
      }
      setRows(body.categories ?? []);
    } catch {
      toast.error('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setFormName('');
    setFormParentId('none');
    setFormSortOrder('0');
    setEditor({ mode: 'create' });
  };

  const openEdit = (row: CategoryRow) => {
    setFormName(row.name);
    setFormParentId(row.parent_id ?? 'none');
    setFormSortOrder(String(row.sort_order));
    setEditor({ mode: 'edit', row });
  };

  const save = async () => {
    if (!editor) return;
    const name = formName.trim();
    if (!name) {
      toast.error('请输入分类名');
      return;
    }
    if (name.length > 64) {
      toast.error('分类名需为 1-64 个字符');
      return;
    }
    const sortOrder = Math.trunc(Number(formSortOrder) || 0);
    setSaving(true);
    try {
      const parentId = formParentId === 'none' ? null : formParentId;
      const response = await fetch('/api/admin/categories', {
        method: editor.mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify(
          editor.mode === 'create'
            ? { name, parentId, sortOrder }
            : { id: editor.row.id, name, parentId, sortOrder },
        ),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '保存失败');
        return;
      }
      toast.success(editor.mode === 'create' ? '分类已创建' : '分类已更新');
      setEditor(null);
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: CategoryRow) => {
    const count = Number(row.course_count);
    const message =
      count > 0
        ? `分类「${row.name}」下有 ${count} 门课程，删除后这些课程将变为未分类（课程本身保留）。确定删除？`
        : `确定删除分类「${row.name}」？`;
    if (!confirm(message)) return;
    try {
      const response = await fetch(`/api/admin/categories?id=${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-request': '1' },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '删除失败');
        return;
      }
      toast.success('分类已删除');
      await load();
    } catch {
      toast.error('网络错误');
    }
  };

  // Reparent targets for the editor: anything except the edited row and its
  // subtree (the server refuses those cycles; hiding them avoids the error).
  const parentCandidates = useMemo(() => {
    if (!editor || editor.mode === 'create') return rows;
    const blocked = descendantIds(rows, editor.row.id);
    return rows.filter((row) => !blocked.has(row.id));
  }, [rows, editor]);

  const ordered = useMemo(() => layoutTree(rows), [rows]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">课堂分类</h1>
          <p className="text-muted-foreground text-sm">
            课程的分类树（支持层级），课程页可按分类筛选与归类
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            新建分类
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {loading && rows.length === 0 ? (
            <div className="text-muted-foreground flex justify-center py-16">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : ordered.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">
              还没有分类，点击右上角「新建分类」创建
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>分类</TableHead>
                  <TableHead className="text-right">排序</TableHead>
                  <TableHead className="text-right">课程数</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map(({ row, depth }) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 20 }}>
                        {depth > 0 ? (
                          <span className="text-muted-foreground select-none text-xs">└</span>
                        ) : null}
                        <span className="font-medium">{row.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.sort_order}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.course_count}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(row.created_at).toLocaleString('zh-CN')}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                          <Pencil className="size-4" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void remove(row)}
                        >
                          <Trash2 className="size-4" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editor?.mode === 'create' ? '新建分类' : '编辑分类'}</DialogTitle>
            <DialogDescription>名称、父分类与排序都会即时保存到分类树</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="category-name">名称</Label>
              <Input
                id="category-name"
                value={formName}
                placeholder="如：编程入门"
                onChange={(event) => setFormName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>父分类</Label>
              <Select value={formParentId} onValueChange={setFormParentId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">顶级分类</SelectItem>
                  {parentCandidates.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="category-sort">排序（小的在前）</Label>
              <Input
                id="category-sort"
                type="number"
                value={formSortOrder}
                onChange={(event) => setFormSortOrder(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditor(null)} disabled={saving}>
                取消
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
