/**
 * Generation call trace — the admin-console answer to "where did this
 * course's generation time go".
 *
 * One row per generation-route HTTP call (scene-content / scene-actions /
 * tts / image / video), including FAILED calls (which usage_ledger never
 * sees, because they carry no billable usage) and the wall-clock duration.
 * Writes come from lib/server/generation-trace.ts, fire-and-forget, and
 * inherit the usage-ledger design rules:
 *
 * - Fire-and-forget: a trace failure must never break generation. Errors log
 *   once per burst and are swallowed.
 * - Tests never write: the emit guard in lib/server/generation-trace.ts
 *   returns early under VITEST, so this sink is only reachable from a real
 *   server.
 * - Best-effort enablement: no DATABASE_URL → no-op.
 * - Bounded growth: rows older than ~30 days are pruned opportunistically,
 *   at most once per 6 h per process, on the write path (the path is already
 *   async and off the request critical path).
 */
import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationTrace');

/** The generation routes that emit trace rows. */
export type GenerationTraceStep = 'scene-content' | 'scene-actions' | 'tts' | 'image' | 'video';

export interface GenerationTraceInsert {
  step: GenerationTraceStep;
  stageId?: string;
  ownerId?: string;
  /** 1-based page order, only meaningful for the two LLM routes. */
  page?: number;
  providerId?: string;
  modelId?: string;
  durationMs: number;
  status: 'ok' | 'error';
  httpStatus?: number;
  errorCode?: string;
  errorSnippet?: string;
}

const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Same log-once-per-burst throttle as the usage ledger. */
let consecutiveFailures = 0;
const MAX_LOGGED_FAILURES = 5;
let lastPruneAt = 0;

export async function recordGenerationTraceRow(row: GenerationTraceInsert): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    const pool = await getAdminPool();
    await pool.query(
      `INSERT INTO generation_trace
         (stage_id, owner_id, step, page, provider_id, model_id,
          duration_ms, status, http_status, error_code, error_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.stageId ?? null,
        row.ownerId ?? null,
        row.step,
        row.page ?? null,
        row.providerId ?? null,
        row.modelId ?? null,
        row.durationMs,
        row.status,
        row.httpStatus ?? null,
        row.errorCode ?? null,
        row.errorSnippet ?? null,
      ],
    );
    consecutiveFailures = 0;
    // Stamp the window BEFORE the delete so a failing prune does not retry on
    // every write; the whole emit path is already off the request path.
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      await pool.query(
        "DELETE FROM generation_trace WHERE created_at < now() - ($1 || ' days')::interval",
        [String(RETENTION_DAYS)],
      );
    }
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures <= MAX_LOGGED_FAILURES) {
      log.warn('generation_trace write failed (generation unaffected):', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Read models for the admin 生成过程 drill-down
// ---------------------------------------------------------------------------

export interface GenerationTraceRow {
  id: number;
  createdAt: string;
  stageId: string | null;
  ownerId: string | null;
  step: string;
  page: number | null;
  providerId: string | null;
  modelId: string | null;
  durationMs: number;
  status: string;
  httpStatus: number | null;
  errorCode: string | null;
  errorSnippet: string | null;
}

export interface GenerationTraceStepSummary {
  step: string;
  calls: number;
  errors: number;
  avgMs: number;
  totalMs: number;
}

export interface GenerationTraceSummary {
  steps: GenerationTraceStepSummary[];
  totalCalls: number;
  totalErrors: number;
  firstCallAt: string | null;
  lastCallAt: string | null;
}

export async function queryGenerationTraceByStage(
  stageId: string,
  limit = 500,
): Promise<GenerationTraceRow[]> {
  const pool = await getAdminPool();
  const result = await pool.query<{
    id: string;
    created_at: Date;
    stage_id: string | null;
    owner_id: string | null;
    step: string;
    page: number | null;
    provider_id: string | null;
    model_id: string | null;
    duration_ms: number;
    status: string;
    http_status: number | null;
    error_code: string | null;
    error_snippet: string | null;
  }>(
    `SELECT id, created_at, stage_id, owner_id, step, page, provider_id, model_id,
            duration_ms, status, http_status, error_code, error_snippet
     FROM generation_trace WHERE stage_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [stageId, limit],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    createdAt: row.created_at.toISOString(),
    stageId: row.stage_id,
    ownerId: row.owner_id,
    step: row.step,
    page: row.page,
    providerId: row.provider_id,
    modelId: row.model_id,
    durationMs: row.duration_ms,
    status: row.status,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    errorSnippet: row.error_snippet,
  }));
}

export async function queryGenerationTraceSummary(
  stageId: string,
): Promise<GenerationTraceSummary> {
  const pool = await getAdminPool();
  const steps = await pool.query<{
    step: string;
    calls: string;
    errors: string;
    avg_ms: string;
    total_ms: string;
  }>(
    `SELECT step,
            COUNT(*)::text AS calls,
            COUNT(*) FILTER (WHERE status <> 'ok')::text AS errors,
            COALESCE(ROUND(AVG(duration_ms)), 0)::text AS avg_ms,
            COALESCE(SUM(duration_ms), 0)::text AS total_ms
     FROM generation_trace WHERE stage_id = $1
     GROUP BY step ORDER BY SUM(duration_ms) DESC`,
    [stageId],
  );
  const span = await pool.query<{ first: Date | null; last: Date | null }>(
    `SELECT MIN(created_at) AS first, MAX(created_at) AS last
     FROM generation_trace WHERE stage_id = $1`,
    [stageId],
  );
  const mapped = steps.rows.map((row) => ({
    step: row.step,
    calls: Number(row.calls),
    errors: Number(row.errors),
    avgMs: Number(row.avg_ms),
    totalMs: Number(row.total_ms),
  }));
  return {
    steps: mapped,
    totalCalls: mapped.reduce((sum, s) => sum + s.calls, 0),
    totalErrors: mapped.reduce((sum, s) => sum + s.errors, 0),
    firstCallAt: span.rows[0]?.first ? span.rows[0].first.toISOString() : null,
    lastCallAt: span.rows[0]?.last ? span.rows[0].last.toISOString() : null,
  };
}
