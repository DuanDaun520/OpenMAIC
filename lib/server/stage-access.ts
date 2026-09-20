/**
 * Server-side document ownership, visibility, and tombstone resolution — the
 * reference's `stage-access.ts`, ported onto this branch's server provider.
 *
 * `stage_meta` is the tenant companion table beside the tenant-agnostic
 * document store: it records who owns a course, whether it is public, when it
 * was published, whether generation completed, and (via `deleted_at`) the
 * tombstone. This module is the single resolver the viewer-facing routes
 * (`/api/stage-meta/:id`, generation-complete) go through.
 */
import { getAdminPool } from '@/lib/admin/db';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

/** The minimal query surface this module needs; keeps it pool-agnostic for tests. */
export interface StageAccessQueryable {
  query<TRow extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

export interface StageAccess {
  stageId: string;
  ownerId: string;
  name: string;
  isPublic: boolean;
  publishedAt: number | null;
  generationComplete: boolean;
  /** Server-clock epoch millis of the last generation liveness pulse. */
  generationHeartbeatAt: number | null;
  /** Last recorded generation failure reason, when one is on record. */
  generationError: string | null;
  source: 'document';
  deletedAt: Date | null;
  /** Explicit AI-generated cover (course_user_meta.cover_url), else null. */
  coverUrl: string | null;
}

interface RawAccessRow extends Record<string, unknown> {
  meta_owner_id: string | null;
  meta_is_public: boolean | null;
  meta_published_at: string | number | null;
  meta_generation_complete: boolean | null;
  meta_generation_heartbeat_at: number | string | null;
  meta_generation_error: string | null;
  meta_deleted_at: Date | string | null;
  document_name: string | null;
  cover_url: string | null;
}

const ACCESS_SQL = `
  SELECT m.owner_id                  AS meta_owner_id,
         m.is_public                 AS meta_is_public,
         m.published_at              AS meta_published_at,
         m.generation_complete       AS meta_generation_complete,
         m.generation_heartbeat_at   AS meta_generation_heartbeat_at,
         m.generation_error          AS meta_generation_error,
         m.deleted_at                AS meta_deleted_at,
         d.name                      AS document_name,
         cov.cover_url               AS cover_url
    FROM (SELECT $1::text AS stage_id) k
    LEFT JOIN stage_meta      m ON m.stage_id = k.stage_id
    LEFT JOIN document_stages d ON d.id       = k.stage_id
    LEFT JOIN course_user_meta cov ON cov.stage_id = k.stage_id
`;

function toEpochMillis(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * Reject an id PostgreSQL cannot bind as `text`.
 *
 * Same reason as `lib/persistence/document-access.ts`'s copy: a `%00` or
 * lone-surrogate segment in the URL would make `WHERE stage_id = $1` throw at
 * the driver, turning a request that should be a clean 404 into a logged 500.
 * Such an id can provably never match a stored row, so classifying it as "no
 * such course" is exact, not defensive rounding.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
function isQueryableStageId(stageId: string): boolean {
  return !stageId.includes('\u0000') && !LONE_SURROGATE.test(stageId);
}

async function queryableFor(): Promise<StageAccessQueryable> {
  return getStageAccessDb();
}

/** The stage-meta query surface backed by the server persistence provider's pool. */
export async function getStageAccessDb(): Promise<StageAccessQueryable> {
  // ACCESS_SQL joins course_user_meta (the explicit AI cover), which the admin
  // schema owns. Bootstrap it first so a fresh database cannot turn every
  // stage-meta read into a missing-relation 500; the call is memoized, so this
  // is a one-time DDL no-op afterwards. Injected-queryable callers (tests,
  // offline tooling) never pass through here.
  if (process.env.DATABASE_URL) await getAdminPool();
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool as unknown as StageAccessQueryable;
}

/**
 * Resolve a course's ownership/visibility WITHOUT applying the tombstone.
 *
 * For the delete path (which must find the row it is about to tombstone, and be
 * idempotent when it is already tombstoned) and for offline tooling. Product
 * read gates want {@link resolveStageAccess}.
 */
export async function readStageAccessIncludingDeleted(
  stageId: string,
  queryable?: StageAccessQueryable,
): Promise<StageAccess | null> {
  if (!isQueryableStageId(stageId)) return null;
  const db = queryable ?? (await queryableFor());
  const result = await db.query<RawAccessRow>(ACCESS_SQL, [stageId]);
  const row = result.rows[0];
  if (!row || row.meta_owner_id === null || row.document_name === null) return null;

  return {
    stageId,
    ownerId: row.meta_owner_id,
    name: row.document_name,
    isPublic: row.meta_is_public === true,
    publishedAt: toEpochMillis(row.meta_published_at),
    generationComplete: row.meta_generation_complete === true,
    generationHeartbeatAt: toEpochMillis(row.meta_generation_heartbeat_at),
    generationError:
      typeof row.meta_generation_error === 'string' && row.meta_generation_error.length > 0
        ? row.meta_generation_error
        : null,
    source: 'document',
    deletedAt: toDate(row.meta_deleted_at),
    coverUrl: typeof row.cover_url === 'string' && row.cover_url.length > 0 ? row.cover_url : null,
  };
}

/**
 * Resolve a course's ownership/visibility for a product read gate.
 *
 * `null` means "no such course, as far as this caller is concerned" — absent,
 * or tombstoned. Callers must not distinguish the two: a deleted course that
 * answered 410 would still confirm the id existed, and the whole point of the
 * tombstone is that a deleted course is gone from the product's point of view
 * while its rows stay on disk.
 */
export async function resolveStageAccess(
  stageId: string,
  queryable?: StageAccessQueryable,
): Promise<StageAccess | null> {
  const access = await readStageAccessIncludingDeleted(stageId, queryable);
  if (!access || access.deletedAt !== null) return null;
  return access;
}
