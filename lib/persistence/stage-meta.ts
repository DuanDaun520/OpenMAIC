import { DocumentNotFoundError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';

export interface StageMetaRow {
  stageId: string;
  ownerId: string;
  isPublic: boolean;
  /** Epoch millis when the owner published the course; null while private. */
  publishedAt: number | null;
  /** Server-side mirror of the document outline's generation-complete flag. */
  generationComplete: boolean;
  /**
   * Epoch millis (server clock) of the last liveness pulse from a browser
   * actively generating this course's pages; null when no pulse ever landed.
   * Freshness of this value — not the document's updated_at — is what
   * distinguishes "really generating" from "interrupted/failed" for pending
   * outlines.
   */
  generationHeartbeatAt: number | null;
  /** Last recorded generation failure reason; null when none is on record. */
  generationError: string | null;
  deletedAt: Date | null;
}

interface RawStageMetaRow extends Record<string, unknown> {
  stage_id: string;
  owner_id: string;
  is_public: boolean;
  published_at: number | string | null;
  generation_complete: boolean;
  generation_heartbeat_at: number | string | null;
  generation_error: string | null;
  deleted_at: Date | string | null;
}

export const STAGE_META_SCHEMA = `
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS published_at DOUBLE PRECISION;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_complete BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_heartbeat_at DOUBLE PRECISION;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_error TEXT;

CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);

CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;

INSERT INTO stage_meta (stage_id, owner_id)
SELECT id, owner_id
  FROM document_stages
 WHERE owner_id IS NOT NULL
ON CONFLICT (stage_id) DO NOTHING;
`;

export async function ensureStageMetaSchema(queryable: Queryable): Promise<void> {
  for (const sql of STAGE_META_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

export async function readStageMeta(
  queryable: Queryable,
  stageId: string,
): Promise<StageMetaRow | null> {
  const result = await queryable.query<RawStageMetaRow>(
    `SELECT stage_id, owner_id, is_public, published_at, generation_complete,
            generation_heartbeat_at, generation_error, deleted_at
       FROM stage_meta
      WHERE stage_id = $1`,
    [stageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const publishedAt = row.published_at;
  const heartbeatAt = row.generation_heartbeat_at;
  return {
    stageId: row.stage_id,
    ownerId: row.owner_id,
    isPublic: row.is_public === true,
    publishedAt:
      publishedAt === null
        ? null
        : typeof publishedAt === 'number'
          ? publishedAt
          : Number(publishedAt),
    generationComplete: row.generation_complete === true,
    generationHeartbeatAt:
      heartbeatAt === null
        ? null
        : typeof heartbeatAt === 'number'
          ? heartbeatAt
          : Number(heartbeatAt),
    generationError:
      typeof row.generation_error === 'string' && row.generation_error.length > 0
        ? row.generation_error
        : null,
    deletedAt:
      row.deleted_at === null
        ? null
        : row.deleted_at instanceof Date
          ? row.deleted_at
          : new Date(row.deleted_at),
  };
}

export type StageAccessRefusal = 'foreign' | 'unclaimed' | 'tombstoned' | 'reserved-document';

export class StageAccessError extends DocumentNotFoundError {
  constructor(
    stageId: string,
    readonly attemptedBy: string,
    readonly refusal: StageAccessRefusal,
  ) {
    super(stageId, `stage access refused (${refusal}) for ${JSON.stringify(stageId)}`);
    (this as { name: string }).name = 'StageAccessError';
  }
}

export async function claimStageMeta(
  queryable: Queryable,
  stageId: string,
  ownerId: string,
): Promise<void> {
  const inserted = await queryable.query<{ owner_id: string } & Record<string, unknown>>(
    `INSERT INTO stage_meta (stage_id, owner_id)
     VALUES ($1, $2)
     ON CONFLICT (stage_id) DO NOTHING
     RETURNING owner_id`,
    [stageId, ownerId],
  );
  if (inserted.rows[0]?.owner_id === ownerId) return;

  const existing = await queryable.query<{ owner_id: string } & Record<string, unknown>>(
    'SELECT owner_id FROM stage_meta WHERE stage_id = $1',
    [stageId],
  );
  if (existing.rows[0]?.owner_id !== ownerId) {
    throw new StageAccessError(stageId, ownerId, 'foreign');
  }
}

export async function tombstoneStageMeta(queryable: Queryable, stageId: string): Promise<void> {
  await queryable.query(
    `UPDATE stage_meta
        SET deleted_at = CURRENT_TIMESTAMP
      WHERE stage_id = $1 AND deleted_at IS NULL`,
    [stageId],
  );
}

/** Monotonically mark a live course's server-side generation-complete flag. */
export async function markStageGenerationComplete(
  queryable: Queryable,
  stageId: string,
): Promise<boolean> {
  const result = await queryable.query<{ stage_id: string } & Record<string, unknown>>(
    `UPDATE stage_meta
        SET generation_complete = true,
            generation_heartbeat_at = NULL,
            generation_error = NULL
      WHERE stage_id = $1 AND deleted_at IS NULL
      RETURNING stage_id`,
    [stageId],
  );
  return result.rows.length === 1;
}

/**
 * Record a liveness pulse from a browser that is generating this course.
 *
 * The timestamp is the SERVER's clock, not the client's, so every consumer
 * (classroom display, course-list badge) compares against the same clock that
 * wrote it — a skewed client cannot make a dead run look live or vice versa.
 * `clearError` marks the start of a fresh run: a retry legitimately invalidates
 * the previously recorded failure reason.
 */
export async function touchGenerationHeartbeat(
  queryable: Queryable,
  stageId: string,
  clearError: boolean,
): Promise<boolean> {
  const result = await queryable.query<{ stage_id: string } & Record<string, unknown>>(
    `UPDATE stage_meta
        SET generation_heartbeat_at = EXTRACT(EPOCH FROM NOW()) * 1000,
            generation_error = CASE WHEN $2 THEN NULL ELSE generation_error END
      WHERE stage_id = $1 AND deleted_at IS NULL
      RETURNING stage_id`,
    [stageId, clearError],
  );
  return result.rows.length === 1;
}

/**
 * Record why generation stopped failing-side. Writing the error also drops the
 * heartbeat: the run is over, so the course must not keep presenting a live
 * spinner off the stale pulse.
 */
export async function recordGenerationError(
  queryable: Queryable,
  stageId: string,
  message: string | null,
): Promise<boolean> {
  const result = await queryable.query<{ stage_id: string } & Record<string, unknown>>(
    `UPDATE stage_meta
        SET generation_error = $2,
            generation_heartbeat_at = NULL
      WHERE stage_id = $1 AND deleted_at IS NULL
      RETURNING stage_id`,
    [stageId, message],
  );
  return result.rows.length === 1;
}

/** Publish (isPublic=true, publishedAt set) or unpublish (isPublic=false, publishedAt cleared). */
export async function setStagePublished(
  queryable: Queryable,
  stageId: string,
  isPublic: boolean,
  publishedAt: number | null,
): Promise<void> {
  await queryable.query(
    `UPDATE stage_meta
        SET is_public = $2, published_at = $3
      WHERE stage_id = $1 AND deleted_at IS NULL`,
    [stageId, isPublic, publishedAt],
  );
}
