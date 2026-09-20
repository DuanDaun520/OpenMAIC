/**
 * DB-side usage ledger — the durable twin of the jsonl usage log.
 *
 * `lib/server/usage-storage.ts` owns capture: every billable call funnels
 * through `recordUsage`, which appends a local jsonl line. This module is the
 * additional sink that mirrors those rows into `usage_ledger` with the actor
 * dimensions the jsonl rows lack (owner, stage). Design rules it inherits:
 *
 * - Fire-and-forget: a ledger failure must never break generation. Errors log
 *   once per burst and are swallowed.
 * - Tests never write: `recordUsage` returns early under VITEST, so the sink
 *   below is only reachable from a real server.
 * - Best-effort enablement: no DATABASE_URL → no-op (pure jsonl mode keeps
 *   working exactly as before).
 */
import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('UsageLedger');

export type LedgerCapability = 'llm' | 'image' | 'video' | 'tts' | 'asr';

export interface UsageLedgerInsert {
  capability: LedgerCapability;
  source?: string;
  providerId: string;
  modelId: string;
  ownerId?: string;
  stageId?: string;
  inputTokens?: number;
  outputTokens?: number;
  quantity: number;
  unit?: string;
}

/** A ledgers write is skipped wholesale when this ever fails consecutively —
 * the console cannot fix the DB from here, and one dropped call must not
 * flood the log. */
let consecutiveFailures = 0;
const MAX_LOGGED_FAILURES = 5;

export async function recordUsageLedgerRow(row: UsageLedgerInsert): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    const pool = await getAdminPool();
    await pool.query(
      `WITH ins AS (
         INSERT INTO usage_ledger
           (capability, source, provider_id, model_id, owner_id, stage_id,
            input_tokens, output_tokens, quantity, unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING quantity
       ), agg AS (
         INSERT INTO usage_daily_agg (day, capability, provider_id, quantity_sum, calls)
         SELECT CURRENT_DATE, $1, $3, quantity, 1 FROM ins
         ON CONFLICT (day, capability, provider_id) DO UPDATE SET
           quantity_sum = usage_daily_agg.quantity_sum + EXCLUDED.quantity_sum,
           calls = usage_daily_agg.calls + 1
         RETURNING 1
       )
       SELECT 1 FROM agg`,
      [
        row.capability,
        row.source ?? null,
        row.providerId,
        row.modelId,
        row.ownerId ?? null,
        row.stageId ?? null,
        row.inputTokens ?? 0,
        row.outputTokens ?? 0,
        row.quantity,
        row.unit ?? null,
      ],
    );
    consecutiveFailures = 0;
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures <= MAX_LOGGED_FAILURES) {
      log.warn('usage_ledger write failed (generation unaffected):', error);
    }
  }
}

/** Backfill `usage_daily_agg` from the raw ledger (e.g. after manual edits or
 * a disabled period). Cheap at P1 volumes; invoked by the usage API. */
export async function rebalanceUsageDailyAgg(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  const pool = await getAdminPool();
  await pool.query(
    `INSERT INTO usage_daily_agg (day, capability, provider_id, quantity_sum, calls)
     SELECT created_at::date, capability, provider_id, SUM(quantity), COUNT(*)
     FROM usage_ledger
     GROUP BY created_at::date, capability, provider_id
     ON CONFLICT (day, capability, provider_id) DO UPDATE SET
       quantity_sum = EXCLUDED.quantity_sum,
       calls = EXCLUDED.calls`,
  );
}

// ---------------------------------------------------------------------------
// Read models for the admin usage page
// ---------------------------------------------------------------------------

export interface UsageSummary {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  quantity: number;
  unitBreakdown: Record<string, number>;
}

export interface UsageBreakdownRow {
  key: string;
  calls: number;
  quantity: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageDailyRow {
  day: string;
  calls: number;
  quantity: number;
}

export interface UsageTopOwnerRow {
  ownerId: string;
  calls: number;
  quantity: number;
}

function sinceClause(days: number): { sql: string; params: unknown[] } {
  return { sql: "created_at > now() - ($1 || ' days')::interval", params: [String(days)] };
}

export async function queryUsageSummary(days: number, capability?: string): Promise<UsageSummary> {
  const pool = await getAdminPool();
  const where = capability ? `${sinceClause(days).sql} AND capability = $2` : sinceClause(days).sql;
  const params = capability ? [String(days), capability] : [String(days)];
  const result = await pool.query<{
    calls: string;
    errors: string;
    input_tokens: string;
    output_tokens: string;
    quantity: string;
  }>(
    `SELECT COUNT(*)::text AS calls,
            COUNT(*) FILTER (WHERE status <> 'ok')::text AS errors,
            COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(quantity), 0)::text AS quantity
     FROM usage_ledger WHERE ${where}`,
    params,
  );
  const units = await pool.query<{ unit: string | null; quantity: string }>(
    `SELECT unit, COALESCE(SUM(quantity), 0)::text AS quantity
     FROM usage_ledger WHERE ${where}
     GROUP BY unit`,
    params,
  );
  const row = result.rows[0];
  return {
    calls: Number(row?.calls ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    quantity: Number(row?.quantity ?? 0),
    unitBreakdown: Object.fromEntries(
      units.rows.map((u) => [u.unit ?? 'unknown', Number(u.quantity)]),
    ),
  };
}

export async function queryUsageBreakdown(
  days: number,
  dimension: 'capability' | 'provider' | 'model',
  capability?: string,
): Promise<UsageBreakdownRow[]> {
  const pool = await getAdminPool();
  const column =
    dimension === 'capability'
      ? 'capability'
      : dimension === 'provider'
        ? 'provider_id'
        : "provider_id || ':' || model_id";
  const where =
    capability && dimension !== 'capability'
      ? `${sinceClause(days).sql} AND capability = $2`
      : sinceClause(days).sql;
  const params =
    capability && dimension !== 'capability' ? [String(days), capability] : [String(days)];
  const rows = await pool.query<{
    key: string;
    calls: string;
    input_tokens: string;
    output_tokens: string;
    quantity: string;
  }>(
    `SELECT ${column} AS key,
            COUNT(*)::text AS calls,
            COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(quantity), 0)::text AS quantity
     FROM usage_ledger WHERE ${where}
     GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 20`,
    params,
  );
  return rows.rows.map((row) => ({
    key: row.key,
    calls: Number(row.calls),
    quantity: Number(row.quantity),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
  }));
}

export async function queryUsageDaily(days: number, capability?: string): Promise<UsageDailyRow[]> {
  const pool = await getAdminPool();
  const where = capability ? `${sinceClause(days).sql} AND capability = $2` : sinceClause(days).sql;
  const params = capability ? [String(days), capability] : [String(days)];
  const rows = await pool.query<{ day: string; calls: string; quantity: string }>(
    `SELECT created_at::date::text AS day,
            COUNT(*)::text AS calls,
            COALESCE(SUM(quantity), 0)::text AS quantity
     FROM usage_ledger WHERE ${where}
     GROUP BY 1 ORDER BY 1`,
    params,
  );
  return rows.rows.map((row) => ({
    day: row.day,
    calls: Number(row.calls),
    quantity: Number(row.quantity),
  }));
}

export async function queryUsageTopOwners(
  days: number,
  capability?: string,
): Promise<UsageTopOwnerRow[]> {
  const pool = await getAdminPool();
  const where = capability ? `${sinceClause(days).sql} AND capability = $2` : sinceClause(days).sql;
  const params = capability ? [String(days), capability] : [String(days)];
  const rows = await pool.query<{ owner_id: string; calls: string; quantity: string }>(
    `SELECT owner_id, COUNT(*)::text AS calls, COALESCE(SUM(quantity), 0)::text AS quantity
     FROM usage_ledger
     WHERE owner_id IS NOT NULL AND ${where}
     GROUP BY owner_id ORDER BY COUNT(*) DESC LIMIT 10`,
    params,
  );
  return rows.rows.map((row) => ({
    ownerId: row.owner_id,
    calls: Number(row.calls),
    quantity: Number(row.quantity),
  }));
}

/** Raw ledger rows for CSV export (bounded). */
export async function queryUsageLedgerRows(
  days: number,
  limit = 50_000,
): Promise<
  {
    createdAt: string;
    capability: string;
    providerId: string;
    modelId: string;
    ownerId: string | null;
    stageId: string | null;
    inputTokens: number;
    outputTokens: number;
    quantity: string;
    unit: string | null;
    status: string;
  }[]
> {
  const pool = await getAdminPool();
  const result = await pool.query<{
    created_at: Date;
    capability: string;
    provider_id: string;
    model_id: string;
    owner_id: string | null;
    stage_id: string | null;
    input_tokens: number;
    output_tokens: number;
    quantity: string;
    unit: string | null;
    status: string;
  }>(
    `SELECT created_at, capability, provider_id, model_id, owner_id, stage_id,
            input_tokens, output_tokens, quantity::text AS quantity, unit, status
     FROM usage_ledger WHERE created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT $2`,
    [String(days), limit],
  );
  return result.rows.map((row) => ({
    createdAt: row.created_at.toISOString(),
    capability: row.capability,
    providerId: row.provider_id,
    modelId: row.model_id,
    ownerId: row.owner_id,
    stageId: row.stage_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    quantity: row.quantity,
    unit: row.unit,
    status: row.status,
  }));
}
