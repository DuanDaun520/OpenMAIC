'use client';

/**
 * /admin/voices — TTS 音色管理.
 *
 * Edits the effective voice catalog each picker offers: rename / re-gender /
 * hide registry voices (fixing mislabeled catalog entries without a deploy),
 * and append custom voices the provider serves but the registry doesn't know.
 * Writes take effect on the next request — the server patches its overlay
 * synchronously, and clients refetch /api/voice-overrides on their TTL.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, RotateCcw, Volume2 } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface EffectiveVoice {
  id: string;
  name: string;
  language?: string;
  gender?: 'male' | 'female' | 'neutral';
  description?: string;
  /** True when this row is an admin-added voice, not a registry preset. */
  isCustomAddition: boolean;
  /** True when a hidden override suppresses this preset. */
  hidden?: boolean;
  /** True when any override row touches this voice. */
  overridden?: boolean;
}

interface ProviderGroup {
  providerId: string;
  providerName: string;
  voices: EffectiveVoice[];
}

interface VoicesResponse {
  providers: ProviderGroup[];
  orphaned: Array<{
    providerId: string;
    voiceId: string;
    name: string | null;
    hidden: boolean;
  }>;
}

interface EditorState {
  open: boolean;
  providerId: string;
  /** Empty voiceId = creating a custom addition. */
  voiceId: string;
  originalVoiceId: string;
  presetName: string;
  name: string;
  language: string;
  gender: '' | 'male' | 'female' | 'neutral';
  hidden: boolean;
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  providerId: '',
  voiceId: '',
  originalVoiceId: '',
  presetName: '',
  name: '',
  language: '',
  gender: '',
  hidden: false,
};

const GENDER_LABELS: Record<string, string> = {
  male: '男声',
  female: '女声',
  neutral: '中性',
};

export default function AdminVoicesPage() {
  const [data, setData] = useState<VoicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/voices');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || '加载失败');
        return;
      }
      setData(body as VoicesResponse);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const overrideCount = useMemo(
    () =>
      data?.providers.reduce(
        (sum, provider) => sum + provider.voices.filter((voice) => voice.overridden).length,
        0,
      ) ?? 0,
    [data],
  );

  function openCreate(provider: ProviderGroup) {
    setEditor({
      ...EMPTY_EDITOR,
      open: true,
      providerId: provider.providerId,
    });
  }

  function openEdit(provider: ProviderGroup, voice: EffectiveVoice) {
    setEditor({
      open: true,
      providerId: provider.providerId,
      voiceId: voice.id,
      originalVoiceId: voice.id,
      presetName: voice.isCustomAddition ? '' : voice.name,
      name: voice.name,
      language: voice.language ?? '',
      gender: voice.gender ?? '',
      hidden: voice.hidden === true,
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const response = await fetch('/api/admin/voices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({
          providerId: editor.providerId,
          voiceId: editor.voiceId.trim(),
          name: editor.name.trim() || null,
          language: editor.language.trim() || null,
          gender: editor.gender || null,
          hidden: editor.hidden,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '保存失败');
        return;
      }
      toast.success('已保存，客户端最多 5 分钟内同步生效');
      setEditor(EMPTY_EDITOR);
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(providerId: string, voiceId: string) {
    if (!confirm(`确定清除 ${providerId} / ${voiceId} 的覆盖配置？将恢复注册表预设。`)) return;
    const response = await fetch(
      `/api/admin/voices?providerId=${encodeURIComponent(providerId)}&voiceId=${encodeURIComponent(voiceId)}`,
      { method: 'DELETE', headers: { 'x-admin-request': '1' } },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || '删除失败');
      return;
    }
    toast.success('已恢复预设');
    await load();
  }

  const editingProvider = data?.providers.find((p) => p.providerId === editor.providerId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">音色管理</h1>
          <p className="text-muted-foreground text-sm">
            修正音色名称/性别、隐藏不可用音色、新增自定义音色；客户端与服务端选择器同步生效
            {overrideCount > 0 ? `（当前 ${overrideCount} 条覆盖）` : ''}
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

      {data && data.orphaned.length > 0 ? (
        <Alert>
          <AlertTitle>存在指向未知 Provider 的覆盖配置</AlertTitle>
          <AlertDescription>
            {data.orphaned.map((row) => `${row.providerId}:${row.voiceId}`).join('、')} —
            注册表中已无对应 Provider，可在下方对应条目里删除。
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue={data?.providers[0]?.providerId}>
        <TabsList className="flex-wrap">
          {(data?.providers ?? []).map((provider) => (
            <TabsTrigger key={provider.providerId} value={provider.providerId}>
              {provider.providerName}
            </TabsTrigger>
          ))}
        </TabsList>

        {(data?.providers ?? []).map((provider) => {
          const visible = provider.voices.filter((voice) => !voice.hidden);
          const hidden = provider.voices.filter((voice) => voice.hidden);
          return (
            <TabsContent key={provider.providerId} value={provider.providerId} className="mt-4">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base">{provider.providerName} · 音色表</CardTitle>
                    <CardDescription>
                      显示名与性别影响选择器展示及老师头像联动；隐藏 =
                      不再出现在任何选择器（已绑定课程不受影响）
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={() => openCreate(provider)}>
                    <Plus className="size-4" />
                    新增音色
                  </Button>
                </CardHeader>
                <CardContent>
                  {visible.length + hidden.length === 0 ? (
                    <p className="text-muted-foreground py-6 text-center text-sm">
                      该 Provider 无预置音色。
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Voice ID</TableHead>
                          <TableHead>显示名称</TableHead>
                          <TableHead>性别</TableHead>
                          <TableHead>语言</TableHead>
                          <TableHead>来源</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visible.map((voice) => (
                          <TableRow key={voice.id}>
                            <TableCell className="max-w-64 truncate font-mono text-xs">
                              {voice.id}
                            </TableCell>
                            <TableCell className="font-medium">{voice.name}</TableCell>
                            <TableCell>
                              {voice.gender ? (GENDER_LABELS[voice.gender] ?? voice.gender) : '—'}
                            </TableCell>
                            <TableCell className="text-xs">{voice.language ?? '—'}</TableCell>
                            <TableCell>
                              {voice.isCustomAddition ? (
                                <Badge variant="secondary">自定义</Badge>
                              ) : voice.overridden ? (
                                <Badge variant="outline">已覆盖</Badge>
                              ) : (
                                <span className="text-muted-foreground text-xs">预设</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEdit(provider, voice)}
                                >
                                  <Pencil className="size-4" />
                                  编辑
                                </Button>
                                {voice.overridden ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void handleReset(provider.providerId, voice.id)}
                                  >
                                    <RotateCcw className="size-4" />
                                    恢复预设
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                        {hidden.map((voice) => (
                          <TableRow key={voice.id} className="opacity-50">
                            <TableCell className="max-w-64 truncate font-mono text-xs">
                              {voice.id}
                            </TableCell>
                            <TableCell className="font-medium">
                              {voice.name}
                              <Badge variant="destructive" className="ml-2">
                                已隐藏
                              </Badge>
                            </TableCell>
                            <TableCell>—</TableCell>
                            <TableCell>—</TableCell>
                            <TableCell>
                              {voice.isCustomAddition ? (
                                <Badge variant="secondary">自定义</Badge>
                              ) : (
                                <span className="text-muted-foreground text-xs">预设</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEdit(provider, voice)}
                                >
                                  <Pencil className="size-4" />
                                  编辑
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void handleReset(provider.providerId, voice.id)}
                                >
                                  <RotateCcw className="size-4" />
                                  恢复预设
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
            </TabsContent>
          );
        })}
      </Tabs>

      <Dialog open={editor.open} onOpenChange={(open) => !open && setEditor(EMPTY_EDITOR)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Volume2 className="size-4" />
              {editor.originalVoiceId ? '编辑音色' : '新增音色'} ·{' '}
              {editingProvider?.providerName ?? editor.providerId}
            </DialogTitle>
            <DialogDescription>
              {editor.originalVoiceId
                ? editor.presetName
                  ? `预设名称：${editor.presetName}。留空的字段沿用预设值。`
                  : '留空的字段沿用已保存的值。'
                : '新增一个注册表之外、但该 Provider 实际可合成的音色（例如控制台新开通的音色）。'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="voice-id">Voice ID</Label>
              <Input
                id="voice-id"
                value={editor.voiceId}
                placeholder="例如 zh_female_cancan_uranus_bigtts"
                onChange={(event) =>
                  setEditor((state) => ({ ...state, voiceId: event.target.value }))
                }
                disabled={!!editor.originalVoiceId}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="voice-name">显示名称</Label>
              <Input
                id="voice-name"
                value={editor.name}
                placeholder={editor.presetName || '例如 知性灿灿 2.0'}
                onChange={(event) => setEditor((state) => ({ ...state, name: event.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label>性别</Label>
                <Select
                  value={editor.gender || 'keep'}
                  onValueChange={(value) =>
                    setEditor((state) => ({
                      ...state,
                      gender: value === 'keep' ? '' : (value as EditorState['gender']),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep">沿用</SelectItem>
                    <SelectItem value="female">女声</SelectItem>
                    <SelectItem value="male">男声</SelectItem>
                    <SelectItem value="neutral">中性</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="voice-language">语言</Label>
                <Input
                  id="voice-language"
                  value={editor.language}
                  placeholder="例如 zh-CN"
                  onChange={(event) =>
                    setEditor((state) => ({ ...state, language: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div>
                <div className="text-sm">在选择器中隐藏</div>
                <div className="text-muted-foreground text-xs">
                  隐藏后不再出现在音色选择器与 AI 绑定列表；已生成课程不受影响
                </div>
              </div>
              <Switch
                checked={editor.hidden}
                onCheckedChange={(checked) => setEditor((state) => ({ ...state, hidden: checked }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(EMPTY_EDITOR)}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !editor.voiceId.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
