/**
 * Course generation status — the SQL truth onto the card-facing badge.
 *
 * Shared by /api/my-courses (own shelf) and /api/admin/courses (console);
 * keep the two listings answering the same question the same way.
 */

/** A course whose generation heartbeat went silent longer than this is 失败. */
export const GENERATING_STALE_MS = 10 * 60 * 1000;

/**
 * A heartbeat older than this no longer counts as "a live tab is generating",
 * even while the document's updated_at is still inside the coarser
 * GENERATING_STALE_MS window (a single slow scene can easily outlive it
 * without landing a save).
 */
export const GENERATION_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

export type CourseGenerationStatus = 'completed' | 'generating' | 'failed';

/** The stage_meta / document_outlines columns both list queries select. */
export interface CourseGenerationFacts {
  /** stage_meta.generation_complete */
  generationComplete: boolean | null;
  /** document_outlines.data ->> 'generationComplete' ('true' when set). */
  outlineGenerationComplete: string | null;
  /** stage_meta.generation_heartbeat_at — server-clock epoch millis. */
  generationHeartbeatAt: number | null;
  /** document_stages.updated_at — epoch millis. */
  updatedAtMs: number;
}

export function courseGenerationStatus(
  facts: CourseGenerationFacts,
  now: number,
): CourseGenerationStatus {
  const complete = facts.generationComplete === true || facts.outlineGenerationComplete === 'true';
  if (complete) return 'completed';
  // A fresh heartbeat says a live tab is generating, whatever updated_at says.
  if (
    facts.generationHeartbeatAt !== null &&
    now - facts.generationHeartbeatAt < GENERATION_HEARTBEAT_STALE_MS
  ) {
    return 'generating';
  }
  // Not signaled complete and nobody is pulsing: a fresh document may still be
  // between pulses; one whose writes went stale is presentationally failed
  // (the client-driven pipeline stops when the tab closes).
  return now - facts.updatedAtMs < GENERATING_STALE_MS ? 'generating' : 'failed';
}
