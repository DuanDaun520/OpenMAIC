'use client';

/**
 * /admin/models — provider configuration per capability (P0).
 *
 * A row saved here takes precedence over env/YAML for that provider and takes
 * effect on the next request (the server patches its in-memory overlay on
 * write — no restart). Deleting a row falls the provider back to env/YAML.
 * Keys are write-only in the UI: the API returns only a masked tail.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const CAPABILITIES = [
  { key: 'llm', label: '文本 (LLM)' },
  { key: 'tts', label: '语音合成 (TTS)' },
  { key: 'asr', label: '语音识别 (ASR)' },
  { key: 'pdf', label: '文档解析 (PDF)' },
  { key: 'image', label: '图片生成' },
  { key: 'video', label: '视频生成' },
  { key: 'websearch', label: '联网搜索' },
] as const;

type CapabilityKey = (typeof CAPABILITIES)[number]['key'];

interface ClientProviderRow {
  capability: CapabilityKey;
  providerId: string;
  hasApiKey: boolean;
  apiKeyTail: string | null;
  baseUrl: string | null;
  models: string[];
  proxy: string | null;
  enabled: boolean;
  updatedAt: string;
}

interface ProvidersResponse {
  rows: ClientProviderRow[];
  envOnly: Record<string, string[]>;
  encryptionConfigured: boolean;
}

interface EditorState {
  open: boolean;
  capability: CapabilityKey;
  /** Empty when creating a brand-new provider id. */
  originalProviderId: string;
  providerId: string;
  apiKey: string;
  baseUrl: string;
  models: string;
  proxy: string;
  enabled: boolean;
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  capability: 'llm',
  originalProviderId: '',
  providerId: '',
  apiKey: '',
  baseUrl: '',
  models: '',
  proxy: '',
  enabled: true,
};

export default function AdminModelsPage() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/providers');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || '加载失败');
        return;
      }
      setData(body as ProvidersResponse);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rowsByCapability = useMemo(() => {
    const map: Record<string, ClientProviderRow[]> = {};
    for (const capability of CAPABILITIES) {
      map[capability.key] = data?.rows.filter((row) => row.capability === capability.key) ?? [];
    }
    return map;
  }, [data]);

  function openCreate(capability: CapabilityKey) {
    setEditor({ ...EMPTY_EDITOR, open: true, capability });
  }

  function openEdit(row: ClientProviderRow) {
    setEditor({
      open: true,
      capability: row.capability,
      originalProviderId: row.providerId,
      providerId: row.providerId,
      apiKey: '',
      baseUrl: row.baseUrl ?? '',
      models: row.models.join(', '),
      proxy: row.proxy ?? '',
      enabled: row.enabled,
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const response = await fetch('/api/admin/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({
          capability: editor.capability,
          providerId: editor.providerId.trim(),
          // Omitted keeps the stored key; an explicit empty string clears it.
          ...(editor.apiKey === '' ? {} : { apiKey: editor.apiKey }),
          baseUrl: editor.baseUrl.trim(),
          models: editor.models
            .split(',')
            .map((model) => model.trim())
            .filter(Boolean),
          proxy: editor.proxy.trim(),
          enabled: editor.enabled,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '保存失败');
        return;
      }
      if (body.warning) toast.warning(body.warning);
      else toast.success('已保存，立即生效');
      setEditor(EMPTY_EDITOR);
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(row: ClientProviderRow) {
    if (!confirm(`确定删除 ${row.providerId} 的 DB 配置？删除后回落到 env/YAML（如有）。`)) return;
    const response = await fetch(
      `/api/admin/providers?capability=${row.capability}&providerId=${encodeURIComponent(row.providerId)}`,
      { method: 'DELETE', headers: { 'x-admin-request': '1' } },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || '删除失败');
      return;
    }
    toast.success('已删除，回落到 env/YAML 配置');
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">模型配置</h1>
          <p className="text-muted-foreground text-sm">
            DB 配置优先于 env/YAML；保存后免重启立即生效
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : null}
          刷新
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data && !data.encryptionConfigured ? (
        <Alert>
          <AlertTitle>未设置 OPENMAIC_ADMIN_SECRET</AlertTitle>
          <AlertDescription>API Key 将以明文标记存库，仅限本地开发使用。</AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="llm">
        <TabsList className="flex-wrap">
          {CAPABILITIES.map((capability) => (
            <TabsTrigger key={capability.key} value={capability.key}>
              {capability.label}
              {rowsByCapability[capability.key]?.length ? (
                <Badge variant="secondary" className="ml-1.5">
                  {rowsByCapability[capability.key].length}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {CAPABILITIES.map((capability) => {
          const rows = rowsByCapability[capability.key] ?? [];
          const envOnly = data?.envOnly[capability.key] ?? [];
          return (
            <TabsContent key={capability.key} value={capability.key} className="mt-4">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base">{capability.label} · DB 配置</CardTitle>
                    <CardDescription>
                      {capability.key === 'llm' || capability.key === 'pdf'
                        ? '停用 = 该 Provider 恢复未托管（客户端可自带凭据）'
                        : '停用 = 对所有客户端强制下线（服务端优先）'}
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={() => openCreate(capability.key)}>
                    <Plus className="size-4" />
                    新增配置
                  </Button>
                </CardHeader>
                <CardContent>
                  {rows.length === 0 ? (
                    <p className="text-muted-foreground py-6 text-center text-sm">
                      暂无 DB 配置。
                      {envOnly.length > 0
                        ? `当前有 ${envOnly.length} 个 Provider 由 env/YAML 管理，可「接管」为 DB 管理。`
                        : '所有 Provider 走 env/YAML 或客户端自带凭据。'}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Provider</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>API Key</TableHead>
                          <TableHead>模型白名单</TableHead>
                          <TableHead>Base URL</TableHead>
                          <TableHead>更新时间</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row) => (
                          <TableRow key={row.providerId}>
                            <TableCell className="font-medium">{row.providerId}</TableCell>
                            <TableCell>
                              {row.enabled ? (
                                <Badge variant="secondary">启用</Badge>
                              ) : (
                                <Badge variant="destructive">停用</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground font-mono text-xs">
                              {row.apiKeyTail ?? '—'}
                            </TableCell>
                            <TableCell className="max-w-64 truncate text-xs">
                              {row.models.length ? row.models.join(', ') : '—'}
                            </TableCell>
                            <TableCell className="max-w-48 truncate text-xs">
                              {row.baseUrl ?? '—'}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {new Date(row.updatedAt).toLocaleString('zh-CN')}
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
                                  onClick={() => void handleDelete(row)}
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

                  {envOnly.length > 0 ? (
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
                      <span className="text-muted-foreground text-xs">
                        env/YAML 管理中（可接管为 DB）：
                      </span>
                      {envOnly.map((providerId) => (
                        <button
                          key={providerId}
                          className="hover:bg-muted inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                          onClick={() =>
                            setEditor({
                              ...EMPTY_EDITOR,
                              open: true,
                              capability: capability.key,
                              providerId,
                            })
                          }
                        >
                          {providerId}
                          <Plus className="size-3" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>

      <Dialog open={editor.open} onOpenChange={(open) => !open && setEditor(EMPTY_EDITOR)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editor.originalProviderId ? '编辑配置' : '新增配置'} ·{' '}
              {CAPABILITIES.find((capability) => capability.key === editor.capability)?.label}
            </DialogTitle>
            <DialogDescription>保存写入数据库并对本进程立即生效；密钥只写不读。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-id">Provider ID</Label>
              <Input
                id="provider-id"
                value={editor.providerId}
                placeholder="例如 deepseek / doubao-tts / tavily"
                onChange={(event) =>
                  setEditor((state) => ({ ...state, providerId: event.target.value }))
                }
                disabled={!!editor.originalProviderId}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-api-key">
                API Key{' '}
                {editor.originalProviderId ? (
                  <span className="text-muted-foreground text-xs">（留空保持不变）</span>
                ) : null}
              </Label>
              <Input
                id="provider-api-key"
                type="password"
                value={editor.apiKey}
                placeholder="sk-..."
                onChange={(event) =>
                  setEditor((state) => ({ ...state, apiKey: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-models">模型白名单（逗号分隔，第一个为默认）</Label>
              <Textarea
                id="provider-models"
                value={editor.models}
                placeholder="deepseek-chat, deepseek-reasoner"
                onChange={(event) =>
                  setEditor((state) => ({ ...state, models: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-base-url">Base URL（可选）</Label>
              <Input
                id="provider-base-url"
                value={editor.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  setEditor((state) => ({ ...state, baseUrl: event.target.value }))
                }
              />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div>
                <div className="text-sm">启用</div>
                <div className="text-muted-foreground text-xs">关闭后按能力类型停用或解除托管</div>
              </div>
              <Switch
                checked={editor.enabled}
                onCheckedChange={(checked) =>
                  setEditor((state) => ({ ...state, enabled: checked }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(EMPTY_EDITOR)}>
              取消
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={saving || !editor.providerId.trim()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
