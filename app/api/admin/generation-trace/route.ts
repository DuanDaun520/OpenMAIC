/**
 * /api/admin/generation-trace — the 课程「生成过程」drill-down's read model.
 *
 * One course's generation-call timeline from `generation_trace` (newest
 * first, bounded) plus a per-step duration summary, so the console can answer
 * "where did this course's generation time go". GET-only like the usage API;
 * rows expire after ~30 days (opportunistic prune on the write path).
 */
import { requireAdmin } from '@/lib/admin/auth';
import {
  queryGenerationTraceByStage,
  queryGenerationTraceSummary,
} from '@/lib/admin/generation-trace-db';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  if (!process.env.DATABASE_URL) {
    return apiError('INTERNAL_ERROR', 503, '生成过程追踪需要配置 DATABASE_URL');
  }

  const stageId = (new URL(request.url).searchParams.get('stageId') ?? '').trim();
  if (!stageId || stageId.length > 200) {
    return apiError('INVALID_REQUEST', 400, 'stageId is required');
  }

  const [rows, summary] = await Promise.all([
    queryGenerationTraceByStage(stageId),
    queryGenerationTraceSummary(stageId),
  ]);

  return Response.json({ success: true, stageId, rows, summary });
}
