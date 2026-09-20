'use client';

/**
 * /admin/quota — quota policy + per-owner balances (P1).
 *
 * Enforcement needs BOTH switches: OPENMAIC_QUOTA_ENFORCED=1 in the
 * deployment env AND the「强制执行」toggle below. The banner states exactly
 * which half is missing so the operator is never confused about why limits
 * are (not) biting.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Save } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface QuotaPolicy {
  dailyAmount: number;
  initialAmount: number;
  enforcement: boolean;
}

interface QuotaAccount {
  ownerKey: string;
  balance: number;
  dailyLastReset: string | null;
  updatedAt: string;
}

interface QuotaGrant {
  id: number;
  ownerKey: string;
  amount: number;
  reason: string;
  note: string | null;
  grantedBy: string | null;
  grantedAt: string;
}

interface QuotaResponse {
  policy: QuotaPolicy;
  accounts: QuotaAccount[];
  grants: QuotaGrant[];
  enforced: boolean;
  envFlagSet: boolean;
}

const REASON_LABELS: Record<string, string> = {
  initial: '初始发放',
  daily: '每日发放',
  admin: '管理员调整',
};

export default function AdminQuotaPage() {
  const [data, setData] = useState<QuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [policyDraft, setPolicyDraft] = useState<QuotaPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantOwnerKey, setGrantOwnerKey] = useState('');
  const [grantAmount, setGrantAmount] = useState('100');
  const [grantNote, setGrantNote] = useState('');
  const [granting, setGranting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/quota');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '加载失败');
        return;
      }
      setData(body as QuotaResponse);
      setPolicyDraft((body as QuotaResponse).policy);
    } catch {
      toast.error('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePolicy(patch: Partial<QuotaPolicy>) {
    setSavingPolicy(true);
    try {
      const response = await fetch('/api/admin/quota', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify(patch),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '保存失败');
        return;
      }
      toast.success('策略已保存');
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setSavingPolicy(false);
    }
  }

  async function submitGrant() {
    setGranting(true);
    try {
      const response = await fetch('/api/admin/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
        body: JSON.stringify({
          ownerKey: grantOwnerKey.trim(),
          amount: Number(grantAmount),
          note: grantNote || undefined,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(body.error || '调整失败');
        return;
      }
      toast.success(`已调整 ${grantOwnerKey.trim()} 的余额`);
      setGrantOpen(false);
      setGrantOwnerKey('');
      setGrantNote('');
      await load();
    } catch {
      toast.error('网络错误');
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">额度管理</h1>
          <p className="text-muted-foreground text-sm">
            生成调用的配额策略与余额（绑定身份 anon:…，登录体系接入后自动延续）
          </p>
        </div>
        <Button size="sm" onClick={() => setGrantOpen(true)}>
          <Plus className="size-4" />
          余额调整
        </Button>
      </div>

      {data && !data.enforced ? (
        <Alert>
          <AlertTitle>额度门禁当前未生效</AlertTitle>
          <AlertDescription>
            {data.envFlagSet
              ? '还差最后一步：打开下方「强制执行」开关。'
              : '需要两步：在 .env.local 设置 OPENMAIC_QUOTA_ENFORCED=1 并重启，然后打开下方「强制执行」开关。'}
          </AlertDescription>
        </Alert>
      ) : null}

      {loading && !data ? (
        <div className="text-muted-foreground flex justify-center py-16">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : data && policyDraft ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">全局策略</CardTitle>
              <CardDescription>
                「每日发放」在身份当天首次调用时自动入账；「初始发放」在身份首次出现时入账一次。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="quota-daily">每日发放量</Label>
                  <Input
                    id="quota-daily"
                    type="number"
                    min={0}
                    value={policyDraft.dailyAmount}
                    onChange={(event) =>
                      setPolicyDraft({ ...policyDraft, dailyAmount: Number(event.target.value) })
                    }
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="quota-initial">初始发放量</Label>
                  <Input
                    id="quota-initial"
                    type="number"
                    min={0}
                    value={policyDraft.initialAmount}
                    onChange={(event) =>
                      setPolicyDraft({ ...policyDraft, initialAmount: Number(event.target.value) })
                    }
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
                <div>
                  <div className="text-sm">强制执行</div>
                  <div className="text-muted-foreground text-xs">
                    开启后余额为 0 的身份调用生成接口会收到 402（还需环境变量
                    OPENMAIC_QUOTA_ENFORCED=1）
                  </div>
                </div>
                <Switch
                  checked={policyDraft.enforcement}
                  onCheckedChange={(checked) =>
                    setPolicyDraft({ ...policyDraft, enforcement: checked })
                  }
                />
              </div>
              <div>
                <Button
                  size="sm"
                  onClick={() => void savePolicy(policyDraft)}
                  disabled={savingPolicy}
                >
                  {savingPolicy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  保存策略
                </Button>
                {data.enforced ? (
                  <Badge variant="secondary" className="ml-3">
                    门禁已生效
                  </Badge>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">余额账户（最近 200）</CardTitle>
            </CardHeader>
            <CardContent>
              {data.accounts.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  暂无账户 — 在「余额调整」中为某个身份创建，或开启强制执行后由首次调用自动创建
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>身份</TableHead>
                      <TableHead className="text-right">余额</TableHead>
                      <TableHead>每日重置</TableHead>
                      <TableHead>更新时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.accounts.map((account) => (
                      <TableRow key={account.ownerKey}>
                        <TableCell className="max-w-64 truncate font-mono text-xs">
                          {account.ownerKey}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {account.balance}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {account.dailyLastReset ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {new Date(account.updatedAt).toLocaleString('zh-CN')}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setGrantOwnerKey(account.ownerKey);
                              setGrantAmount('100');
                              setGrantOpen(true);
                            }}
                          >
                            <Plus className="size-4" />
                            调整
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">最近发放记录</CardTitle>
            </CardHeader>
            <CardContent>
              {data.grants.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">暂无记录</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>身份</TableHead>
                      <TableHead className="text-right">数额</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.grants.map((grant) => (
                      <TableRow key={grant.id}>
                        <TableCell className="max-w-56 truncate font-mono text-xs">
                          {grant.ownerKey}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{grant.amount}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {REASON_LABELS[grant.reason] ?? grant.reason}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-40 truncate text-xs">
                          {grant.note ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {new Date(grant.grantedAt).toLocaleString('zh-CN')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>余额调整</DialogTitle>
            <DialogDescription>
              正数充值、负数扣减（扣减后余额不会低于 0）。身份即调用方的 anon:…
              标识，可在「用量统计」的 Top 用户里复制。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="grant-owner">身份（ownerKey）</Label>
              <Input
                id="grant-owner"
                value={grantOwnerKey}
                placeholder="anon:0123abcd-…"
                onChange={(event) => setGrantOwnerKey(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="grant-amount">数额</Label>
              <Input
                id="grant-amount"
                type="number"
                value={grantAmount}
                onChange={(event) => setGrantAmount(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="grant-note">备注（可选）</Label>
              <Input
                id="grant-note"
                value={grantNote}
                onChange={(event) => setGrantNote(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void submitGrant()} disabled={granting || !grantOwnerKey.trim()}>
              {granting ? <Loader2 className="size-4 animate-spin" /> : null}
              确认调整
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
