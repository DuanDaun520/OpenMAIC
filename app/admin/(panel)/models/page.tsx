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
import { Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
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
  /** Masked tails for extra credentials (AliDocMind AK/SK), field → tail. */
  extraSecretTails: Record<string, string | null>;
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

/** One planned row from POST /api/admin/providers/import (dry-run plan). */
interface ImportPlanRow {
  capability: string;
  providerId: string;
  hasApiKey: boolean;
  apiKeyTail: string | null;
  /** Field names of extra credentials riding the row (AliDocMind AK/SK). */
  extraSecretFields: string[];
  baseUrl: string | null;
  models: string[];
  proxy: string | null;
  enabled: boolean;
  willSkip: boolean;
}

interface ImportPlan {
  plan: ImportPlanRow[];
  counts: { total: number; toImport: number; skipped: number };
  warnings: string[];
}

/**
 * A provider in one capability, from either config source. Keeps the
 * per-capability tables on one row renderer: DB rows are fully editable,
 * env/YAML rows show origin and offer 接管.
 */
type UnifiedRow =
  | { source: 'db'; capability: CapabilityKey; row: ClientProviderRow }
  | { source: 'env'; capability: CapabilityKey; providerId: string };

interface EditorState {
  open: boolean;
  capability: CapabilityKey;
  /** Empty when creating a brand-new provider id. */
  originalProviderId: string;
  providerId: string;
  apiKey: string;
  /** AliDocMind AccessKey pair — write-only, shown for pdf:alidocmind only. */
  accessKeyId: string;
  accessKeySecret: string;
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
  accessKeyId: '',
  accessKeySecret: '',
  baseUrl: '',
  models: '',
  proxy: '',
  enabled: true,
};

/** AliDocMind is the one provider whose credentials are an AK/SK pair rather
 *  than a single API key; its editor shows the two extra write-only fields. */
function isAliDocMindEditor(state: EditorState): boolean {
  return state.capability === 'pdf' && state.providerId.trim() === 'alidocmind';
}

export default function AdminModelsPage() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);
  // env/YAML → DB import: two-step (dry-run plan → confirm) so the operator
  // sees exactly what would move before anything is written.
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [importForce, setImportForce] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [tab, setTab] = useState('llm');

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

  const countsByCapability = useMemo(() => {
    const map: Record<string, number> = {};
    for (const capability of CAPABILITIES) {
      map[capability.key] =
        (data?.rows.filter((row) => row.capability === capability.key).length ?? 0) +
        (data?.envOnly[capability.key]?.length ?? 0);
    }
    return map;
  }, [data]);

  const unified = useMemo<UnifiedRow[]>(() => {
    if (!data) return [];
    const list: UnifiedRow[] = [];
    for (const capability of CAPABILITIES) {
      for (const row of data.rows.filter((item) => item.capability === capability.key)) {
        list.push({ source: 'db', capability: capability.key, row });
      }
      for (const providerId of data.envOnly[capability.key] ?? []) {
        list.push({ source: 'env', capability: capability.key, providerId });
      }
    }
    return list;
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
      accessKeyId: '',
      accessKeySecret: '',
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
          // AliDocMind AK/SK follow the same convention: blank keeps stored.
          ...(isAliDocMindEditor(editor)
            ? {
                extraSecrets: {
                  ...(editor.accessKeyId ? { accessKeyId: editor.accessKeyId } : {}),
                  ...(editor.accessKeySecret ? { accessKeySecret: editor.accessKeySecret } : {}),
                },
              }
            : {}),
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

  async function openImportPreview(force: boolean) {
    setImportBusy(true);
    try {
      const response = await fetch('/api/admin/providers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ dryRun: true, force }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '生成导入预览失败');
        return;
      }
      setImportForce(force);
      setImportPlan({
        plan: body.plan ?? [],
        counts: body.counts ?? { total: 0, toImport: 0, skipped: 0 },
        warnings: body.warnings ?? [],
      });
    } catch {
      toast.error('网络错误');
    } finally {
      setImportBusy(false);
    }
  }

  async function confirmImport() {
    if (!importPlan || importBusy) return;
    setImportBusy(true);
    try {
      const response = await fetch('/api/admin/providers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({ dryRun: false, force: importForce }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '导入失败');
        return;
      }
      for (const warning of (body.warnings ?? []) as string[]) toast.warning(warning);
      toast.success(`已导入 ${body.imported ?? 0} 项配置，立即生效`);
      setImportPlan(null);
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setImportBusy(false);
    }
  }

  /**
   * The one table renderer for the per-capability tabs. DB rows carry full
   * detail; env/YAML rows show what the files manage and offer 接管.
   */
  function renderRows(entries: UnifiedRow[]) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>API Key</TableHead>
            <TableHead>模型白名单</TableHead>
            <TableHead>Base URL</TableHead>
            <TableHead>代理</TableHead>
            <TableHead>更新时间</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const isDb = entry.source === 'db';
            const providerId = isDb ? entry.row.providerId : entry.providerId;
            return (
              <TableRow key={`${entry.capability}:${providerId}`}>
                <TableCell className="font-medium">{providerId}</TableCell>
                <TableCell>
                  {isDb ? (
                    <Badge variant="secondary">DB</Badge>
                  ) : (
                    <Badge variant="outline">env/YAML</Badge>
                  )}
                </TableCell>
                {isDb ? (
                  <>
                    <TableCell>
                      {entry.row.enabled ? (
                        <Badge variant="secondary">启用</Badge>
                      ) : (
                        <Badge variant="destructive">停用</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      <div className="flex flex-col gap-0.5">
                        <span>{entry.row.apiKeyTail ?? '—'}</span>
                        {Object.entries(entry.row.extraSecretTails ?? {}).map(([field, tail]) => (
                          <span key={field} className="text-[10px]">
                            {field === 'accessKeyId' ? 'AK' : 'SK'} {tail ?? '—'}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-72 flex-wrap gap-1">
                        {entry.row.models.length === 0 ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : (
                          entry.row.models.map((model, index) => (
                            <Badge
                              key={model}
                              variant={index === 0 ? 'secondary' : 'outline'}
                              className="font-mono text-[10px]"
                            >
                              {model}
                              {index === 0 ? ' · 默认' : ''}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className="max-w-48 truncate text-xs"
                      title={entry.row.baseUrl ?? undefined}
                    >
                      {entry.row.baseUrl ?? '—'}
                    </TableCell>
                    <TableCell
                      className="max-w-36 truncate text-xs"
                      title={entry.row.proxy ?? undefined}
                    >
                      {entry.row.proxy ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(entry.row.updatedAt).toLocaleString('zh-CN')}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(entry.row)}>
                          <Pencil className="size-4" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void handleDelete(entry.row)}
                        >
                          <Trash2 className="size-4" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>
                      <span className="text-muted-foreground text-xs">文件管理</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-muted-foreground text-xs">—</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditor({
                            ...EMPTY_EDITOR,
                            open: true,
                            capability: entry.capability,
                            providerId: entry.providerId,
                          })
                        }
                      >
                        <Plus className="size-4" />
                        接管
                      </Button>
                    </TableCell>
                  </>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">模型配置</h1>
          <p className="text-muted-foreground text-sm">
            配置存于数据库并优先于 env/YAML；首次启动自动从 env/YAML 种子导入，免重启即时生效
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openImportPreview(false)}
            disabled={importBusy}
          >
            <Upload className="size-4" />从 env/YAML 导入
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            刷新
          </Button>
        </div>
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

      {loading ? (
        <div className="text-muted-foreground flex justify-center py-16">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            {CAPABILITIES.map((capability) => (
              <TabsTrigger key={capability.key} value={capability.key}>
                {capability.label}
                {countsByCapability[capability.key] ? (
                  <Badge variant="secondary" className="ml-1.5">
                    {countsByCapability[capability.key]}
                  </Badge>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>

          {CAPABILITIES.map((capability) => {
            const tabRows = unified.filter((entry) => entry.capability === capability.key);
            return (
              <TabsContent key={capability.key} value={capability.key} className="mt-4">
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                      <CardTitle className="text-base">{capability.label}</CardTitle>
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
                    {tabRows.length === 0 ? (
                      <p className="text-muted-foreground py-6 text-center text-sm">
                        该能力暂无任何服务商（DB 与 env/YAML 均为空）。
                      </p>
                    ) : (
                      renderRows(tabRows)
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            );
          })}
        </Tabs>
      )}

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
            {isAliDocMindEditor(editor) ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="provider-access-key-id">
                    AccessKey ID{' '}
                    {editor.originalProviderId ? (
                      <span className="text-muted-foreground text-xs">（留空保持不变）</span>
                    ) : null}
                  </Label>
                  <Input
                    id="provider-access-key-id"
                    type="password"
                    value={editor.accessKeyId}
                    placeholder="LTAI..."
                    onChange={(event) =>
                      setEditor((state) => ({ ...state, accessKeyId: event.target.value }))
                    }
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="provider-access-key-secret">
                    AccessKey Secret{' '}
                    {editor.originalProviderId ? (
                      <span className="text-muted-foreground text-xs">（留空保持不变）</span>
                    ) : null}
                  </Label>
                  <Input
                    id="provider-access-key-secret"
                    type="password"
                    value={editor.accessKeySecret}
                    onChange={(event) =>
                      setEditor((state) => ({ ...state, accessKeySecret: event.target.value }))
                    }
                  />
                </div>
              </div>
            ) : null}
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
            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-proxy">代理（可选）</Label>
              <Input
                id="provider-proxy"
                value={editor.proxy}
                placeholder="http://127.0.0.1:7890"
                onChange={(event) =>
                  setEditor((state) => ({ ...state, proxy: event.target.value }))
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

      <Dialog open={!!importPlan} onOpenChange={(open) => !open && setImportPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          {importPlan ? (
            <>
              <DialogHeader>
                <DialogTitle>从环境变量 / server-providers.yml 导入</DialogTitle>
                <DialogDescription>
                  将文件层配置写入数据库（DB 优先）；已存在的行默认跳过——后台的修改始终优先于文件。
                </DialogDescription>
              </DialogHeader>

              {importPlan.warnings.length > 0 ? (
                <Alert>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {importPlan.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="text-muted-foreground text-xs">
                共 {importPlan.counts.total} 项：导入 {importPlan.counts.toImport} 项，跳过{' '}
                {importPlan.counts.skipped} 项（已存在于数据库）
              </div>

              <div className="max-h-72 overflow-y-auto rounded-md border">
                {importPlan.plan.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-center text-sm">
                    env/YAML 均未配置任何服务商，无可导入内容。
                  </p>
                ) : (
                  importPlan.plan.map((row) => (
                    <div
                      key={`${row.capability}:${row.providerId}`}
                      className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0"
                    >
                      <Badge variant={row.willSkip ? 'outline' : 'secondary'}>
                        {row.willSkip ? '跳过' : '导入'}
                      </Badge>
                      <span className="font-medium">{row.capability}</span>
                      <span className="font-mono">{row.providerId}</span>
                      <span className="text-muted-foreground truncate">
                        {row.apiKeyTail ?? '无 Key'}
                        {row.extraSecretFields.length > 0 ? ' · AK/SK' : ''}
                        {row.models.length > 0 ? ` · ${row.models.length} 模型` : ''}
                        {row.baseUrl ? ` · ${row.baseUrl}` : ''}
                        {row.enabled ? '' : ' · 停用'}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
                <div>
                  <div className="text-sm">覆盖已存在的行</div>
                  <div className="text-muted-foreground text-xs">
                    默认跳过；开启后以文件内容覆盖数据库中的同名配置
                  </div>
                </div>
                <Switch
                  checked={importForce}
                  onCheckedChange={(checked) => void openImportPreview(checked)}
                />
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setImportPlan(null)} disabled={importBusy}>
                  取消
                </Button>
                <Button
                  onClick={() => void confirmImport()}
                  disabled={importBusy || importPlan.counts.toImport === 0}
                >
                  {importBusy ? <Loader2 className="size-4 animate-spin" /> : null}
                  导入 {importPlan.counts.toImport} 项
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
