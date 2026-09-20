/**
 * /api/admin/usage — read models over `usage_ledger` (P1).
 *
 * - JSON: summary cards + breakdowns (capability/provider/model) + daily
 *   trend + top owners, over a lookback window (default 7 days, max 90).
 * - `?format=csv`: raw ledger rows as text/csv for offline analysis
 *   (same window, bounded at 50k rows).
 *
 * Each JSON response also wholesale-rebalances `usage_daily_agg` — at P1
 * volumes this keeps the rollup table exactly consistent with the ledger and
 * retires any gap left by a DB outage.
 */
import { requireAdmin } from '@/lib/admin/auth';
import {
  queryUsageBreakdown,
  queryUsageDaily,
  queryUsageLedgerRows,
  queryUsageSummary,
  queryUsageTopOwners,
  rebalanceUsageDailyAgg,
} from '@/lib/admin/usage-db';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

function parseWindow(url: URL): { days: number; capability?: string } {
  const rawDays = Number.parseInt(url.searchParams.get('days') ?? '7', 10);
  const days = Math.min(90, Math.max(1, Number.isFinite(rawDays) ? rawDays : 7));
  const capability = url.searchParams.get('capability') ?? undefined;
  return {
    days,
    capability: capability && capability !== 'all' ? capability : undefined,
  };
}

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  if (!process.env.DATABASE_URL) {
    return apiError('INTERNAL_ERROR', 503, '用量台账需要配置 DATABASE_URL');
  }

  const url = new URL(request.url);
  const { days, capability } = parseWindow(url);

  if (url.searchParams.get('format') === 'csv') {
    const rows = await queryUsageLedgerRows(days);
    const header =
      'created_at,capability,provider_id,model_id,owner_id,stage_id,input_tokens,output_tokens,quantity,unit,status';
    const body = rows
      .map((row) =>
        [
          row.createdAt,
          row.capability,
          row.providerId,
          row.modelId,
          row.ownerId ?? '',
          row.stageId ?? '',
          row.inputTokens,
          row.outputTokens,
          row.quantity,
          row.unit ?? '',
          row.status,
        ]
          .map((cell) => {
            const text = String(cell);
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(','),
      )
      .join('\n');
    return new Response(`${header}\n${body}\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="usage-ledger-${days}d.csv"`,
      },
    });
  }

  await rebalanceUsageDailyAgg().catch(() => undefined);
  const [summary, byCapability, byProvider, byModel, daily, topOwners] = await Promise.all([
    queryUsageSummary(days, capability),
    queryUsageBreakdown(days, 'capability', capability),
    queryUsageBreakdown(days, 'provider', capability),
    queryUsageBreakdown(days, 'model', capability),
    queryUsageDaily(days, capability),
    queryUsageTopOwners(days, capability),
  ]);

  return Response.json({
    success: true,
    days,
    capability: capability ?? 'all',
    summary,
    byCapability,
    byProvider,
    byModel,
    daily,
    topOwners,
  });
}
