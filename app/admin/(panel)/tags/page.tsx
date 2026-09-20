'use client';

/**
 * /admin/tags — course tag management (P1).
 *
 * Flat CRUD over /api/admin/tags: names are unique labels, one sort order,
 * per-tag course counts. Deleting a tag only removes the association from the
 * courses that carried it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, RefreshCw, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface TagRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  course_count: string;
}

type Editor = { mode: 'create' } | { mode: 'edit'; row: TagRow } | null;

export default function AdminTagsPage() {
  const [rows, setRows] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [formName, setFormName] = useState('');
  const [formSortOrder, setFormSortOrder] = useState('0');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/tags');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '加载失败');
        return;
      }
      setRows(body.tags ?? []);
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
    setFormSortOrder('0');
    setEditor({ mode: 'create' });
  };

  const openEdit = (row: TagRow) => {
    setFormName(row.name);
    setFormSortOrder(String(row.sort_order));
    setEditor({ mode: 'edit', row });
  };

  const save = async () => {
    if (!editor) return;
    const name = formName.trim();
    if (!name || name.length > 32) {
      toast.error('标签名需为 1-32 个字符');
      return;
    }
    const sortOrder = Math.trunc(Number(formSortOrder) || 0);
    setSaving(true);
    try {
      const response = await fetch('/api/admin/tags', {
        method: editor.mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify(
          editor.mode === 'create' ? { name, sortOrder } : { id: editor.row.id, name, sortOrder },
        ),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '保存失败');
        return;
      }
      toast.success(editor.mode === 'create' ? '标签已创建' : '标签已更新');
      setEditor(null);
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: TagRow) => {
    const count = Number(row.course_count);
    const message =
      count > 0
        ? `标签「${row.name}」已用于 ${count} 门课程，删除后仅解除关联（课程本身保留）。确定删除？`
        : `确定删除标签「${row.name}」？`;
    if (!confirm(message)) return;
    try {
      const response = await fetch(`/api/admin/tags?id=${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-request': '1' },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '删除失败');
        return;
      }
      toast.success('标签已删除');
      await load();
    } catch {
      toast.error('网络错误');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">课堂标签</h1>
          <p className="text-muted-foreground text-sm">
            平铺的课程标签（一门课程可挂多个），课程页可打标签与按标签筛选
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            新建标签
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
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">
              还没有标签，点击右上角「新建标签」创建
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标签</TableHead>
                  <TableHead className="text-right">排序</TableHead>
                  <TableHead className="text-right">课程数</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{row.name}</Badge>
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
          {rows.length > 0 ? (
            <p className="text-muted-foreground flex items-center gap-1.5 pt-4 text-xs">
              <Tags className="size-3.5" />
              标签在「课程管理」页按课程勾选使用；删除标签不影响课程本身。
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editor?.mode === 'create' ? '新建标签' : '编辑标签'}</DialogTitle>
            <DialogDescription>标签名全局唯一，1-32 个字符</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="tag-name">名称</Label>
              <Input
                id="tag-name"
                value={formName}
                placeholder="如：数学"
                onChange={(event) => setFormName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="tag-sort">排序（小的在前）</Label>
              <Input
                id="tag-sort"
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
