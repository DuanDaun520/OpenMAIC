'use client';

/**
 * /admin/usage — generation consumption over a lookback window (P1).
 *
 * Zero chart dependencies: daily trend and share bars are plain flex/div
 * bars sized by percentage, which stays honest at admin-console data volumes
 * without pulling a chart library into the bundle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface BreakdownRow {
  key: string;
  calls: number;
  quantity: number;
  inputTokens: number;
  outputTokens: number;
}

interface DailyRow {
  day: string;
  calls: number;
  quantity: number;
}

interface UsageResponse {
  days: number;
  capability: string;
  summary: {
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    quantity: number;
    unitBreakdown: Record<string, number>;
  };
  byCapability: BreakdownRow[];
  byProvider: BreakdownRow[];
  byModel: BreakdownRow[];
  daily: DailyRow[];
  topOwners: { ownerId: string; calls: number; quantity: number }[];
}

const CAPABILITY_OPTIONS = [
  { value: 'all', label: '全部能力' },
  { value: 'llm', label: '文本 (LLM)' },
  { value: 'tts', label: '语音合成' },
  { value: 'image', label: '图片生成' },
  { value: 'video', label: '视频生成' },
  { value: 'asr', label: '语音识别' },
] as const;

const UNIT_LABELS: Record<string, string> = {
  token: 'Token',
  character: '字符',
  image: '张',
  second: '秒',
};

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function BarRow({
  label,
  value,
  max,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  suffix: string;
}) {
  const percent = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-40 shrink-0 truncate text-sm" title={label}>
        {label}
      </div>
      <div className="bg-muted h-2.5 flex-1 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: `${percent}%` }} />
      </div>
      <div className="text-muted-foreground w-24 shrink-0 text-right text-xs tabular-nums">
        {formatNumber(value)} {suffix}
      </div>
    </div>
  );
}

export default function AdminUsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [days, setDays] = useState(7);
  const [capability, setCapability] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (windowDays: number, windowCapability: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ days: String(windowDays) });
      if (windowCapability !== 'all') params.set('capability', windowCapability);
      const response = await fetch(`/api/admin/usage?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || '加载失败');
        return;
      }
      setData(body as UsageResponse);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days, capability);
  }, [load, days, capability]);

  const dailyMax = useMemo(
    () => Math.max(1, ...(data?.daily ?? []).map((row) => row.calls)),
    [data],
  );

  const summaryCards = useMemo(() => {
    const summary = data?.summary;
    if (!summary) return [];
    const unitText = Object.entries(summary.unitBreakdown)
      .map(([unit, value]) => `${formatNumber(value)} ${UNIT_LABELS[unit] ?? unit}`)
      .join(' / ');
    return [
      { label: '调用次数', value: formatNumber(summary.calls) },
      { label: '错误数', value: formatNumber(summary.errors) },
      {
        label: 'Token 用量',
        value: `${formatNumber(summary.inputTokens + summary.outputTokens)}（入 ${formatNumber(summary.inputTokens)} / 出 ${formatNumber(summary.outputTokens)}）`,
      },
      { label: '按计量单位', value: unitText || '—' },
    ];
  }, [data]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">用量统计</h1>
          <p className="text-muted-foreground text-sm">生成调用的消耗台账（usage_ledger）</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">今天</SelectItem>
              <SelectItem value="7">近 7 天</SelectItem>
              <SelectItem value="30">近 30 天</SelectItem>
              <SelectItem value="90">近 90 天</SelectItem>
            </SelectContent>
          </Select>
          <Select value={capability} onValueChange={setCapability}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CAPABILITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/api/admin/usage?days=${days}&format=csv`, '_blank')}
          >
            <Download className="size-4" />
            导出 CSV
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading && !data ? (
        <div className="text-muted-foreground flex justify-center py-16">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => (
              <Card key={card.label}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-muted-foreground text-sm font-normal">
                    {card.label}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold tabular-nums">{card.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">每日调用趋势</CardTitle>
            </CardHeader>
            <CardContent>
              {data?.daily.length ? (
                <div>
                  {data.daily.map((row) => (
                    <BarRow
                      key={row.day}
                      label={row.day}
                      value={row.calls}
                      max={dailyMax}
                      suffix="次"
                    />
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  暂无数据 — 生成调用发生后这里会出现趋势
                </p>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">按能力</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.byCapability.length ? (
                  data.byCapability.map((row) => (
                    <BarRow
                      key={row.key}
                      label={
                        CAPABILITY_OPTIONS.find((option) => option.value === row.key)?.label ??
                        row.key
                      }
                      value={row.calls}
                      max={Math.max(...data.byCapability.map((item) => item.calls))}
                      suffix="次"
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground py-4 text-center text-sm">暂无数据</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">按 Provider</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.byProvider.length ? (
                  data.byProvider.map((row) => (
                    <BarRow
                      key={row.key}
                      label={row.key}
                      value={row.calls}
                      max={Math.max(...data.byProvider.map((item) => item.calls))}
                      suffix="次"
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground py-4 text-center text-sm">暂无数据</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">模型明细（Top 20）</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.byModel.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>模型</TableHead>
                        <TableHead className="text-right">调用</TableHead>
                        <TableHead className="text-right">Token</TableHead>
                        <TableHead className="text-right">其他量</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byModel.map((row) => (
                        <TableRow key={row.key}>
                          <TableCell className="max-w-56 truncate font-mono text-xs">
                            {row.key}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.calls)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.inputTokens + row.outputTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.inputTokens + row.outputTokens > 0
                              ? '—'
                              : formatNumber(row.quantity)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-muted-foreground py-4 text-center text-sm">暂无数据</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">消耗最多的用户（Top 10）</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.topOwners.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>身份</TableHead>
                        <TableHead className="text-right">调用</TableHead>
                        <TableHead className="text-right">用量</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.topOwners.map((row) => (
                        <TableRow key={row.ownerId}>
                          <TableCell className="max-w-56 truncate font-mono text-xs">
                            {row.ownerId}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.calls)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.quantity)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-muted-foreground py-4 text-center text-sm">暂无数据</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
