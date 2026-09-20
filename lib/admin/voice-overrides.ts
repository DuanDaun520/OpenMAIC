/**
 * Admin-curated voice catalog overlay (`voice_overrides` table).
 *
 * Mirrors provider-overrides.ts: an in-memory snapshot loaded in the
 * background (TTL) and consumed synchronously, plus a write-through patch so
 * the admin console and the running server see changes without a restart.
 * Rows carry no secrets — just picker metadata — so the same shape is served
 * verbatim to clients via /api/voice-overrides and merged into every voice
 * list (client picker, generation advertisement, server agent catalog).
 */
import { getAdminPool } from '@/lib/admin/db';
import type { VoiceOverride } from '@/lib/audio/voice-override-rules';

/** DB row = the client-safe wire shape plus audit columns. */
export interface VoiceOverrideRow extends VoiceOverride {
  updatedBy: string | null;
  updatedAt: string;
}

interface OverlaySnapshot {
  version: number;
  loadedAt: number;
  rows: VoiceOverrideRow[];
}

const OVERLAY_TTL_MS = 10_000;
const FAILURE_RETRY_MS = 5_000;

let snapshot: OverlaySnapshot | null = null;
let loading: Promise<void> | undefined;
let lastFailureAt = 0;

async function loadOverlay(): Promise<void> {
  const pool = await getAdminPool();
  const result = await pool.query<{
    provider_id: string;
    voice_id: string;
    name: string | null;
    language: string | null;
    gender: string | null;
    description: string | null;
    hidden: boolean;
    sort_order: number;
    updated_by: string | null;
    updated_at: Date;
  }>(`SELECT provider_id, voice_id, name, language, gender, description, hidden, sort_order, updated_by, updated_at
       FROM voice_overrides`);
  const rows: VoiceOverrideRow[] = result.rows.map((row) => ({
    providerId: row.provider_id,
    voiceId: row.voice_id,
    name: row.name,
    language: row.language,
    gender: (row.gender as VoiceOverrideRow['gender']) ?? null,
    description: row.description,
    hidden: row.hidden,
    sortOrder: row.sort_order,
    updatedBy: row.updated_by,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
  // Version bumps only on real change — a routine TTL refresh on identical
  // rows must not churn consumers.
  if (snapshot && JSON.stringify(rows) === JSON.stringify(snapshot.rows)) {
    snapshot = { ...snapshot, loadedAt: Date.now() };
    return;
  }
  snapshot = { version: (snapshot?.version ?? 0) + 1, loadedAt: Date.now(), rows };
}

/**
 * Kick off a background reload when the snapshot is missing or stale. Never
 * throws: failures are logged and retried after a short backoff, leaving the
 * last good snapshot (possibly none) in place.
 */
export function ensureVoiceOverridesFresh(): void {
  const age = snapshot ? Date.now() - snapshot.loadedAt : Infinity;
  const backoff = snapshot ? OVERLAY_TTL_MS : FAILURE_RETRY_MS;
  if (loading || Date.now() - lastFailureAt < backoff || age < backoff) return;
  loading = loadOverlay()
    .catch((error) => {
      lastFailureAt = Date.now();
      console.error(
        '[admin] voice-overrides overlay load failed; serving previous snapshot',
        error,
      );
    })
    .finally(() => {
      loading = undefined;
    });
}

/**
 * Force a load (deduped with any in-flight refresh) and return the rows.
 * APIs use this so their listings are current as of the request.
 */
export async function loadVoiceOverrideRows(): Promise<VoiceOverrideRow[]> {
  if (!loading) {
    loading = loadOverlay()
      .catch((error) => {
        lastFailureAt = Date.now();
        console.error('[admin] voice-overrides overlay load failed', error);
      })
      .finally(() => {
        loading = undefined;
      });
  }
  await loading;
  return snapshot?.rows ?? [];
}

/**
 * Sync snapshot read for server-side voice-list builders (the agent catalog).
 * Triggers a background refresh; the freshly-written rows of THIS process are
 * already visible via the write-through patch, other processes converge on
 * the next TTL refresh.
 */
export function getServerVoiceOverrides(): VoiceOverrideRow[] {
  ensureVoiceOverridesFresh();
  return snapshot?.rows ?? [];
}

/**
 * Write-through patch: upsert (or remove) one row in the in-memory snapshot
 * and bump the version. Call after the DB write commits.
 */
export function patchVoiceOverrideRow(
  row: VoiceOverrideRow | null,
  key: { providerId: string; voiceId: string },
): void {
  if (!snapshot) {
    snapshot = { version: 0, loadedAt: 0, rows: [] };
  }
  const others = snapshot.rows.filter(
    (existing) => !(existing.providerId === key.providerId && existing.voiceId === key.voiceId),
  );
  snapshot.rows = row ? [...others, row] : others;
  snapshot.version += 1;
  snapshot.loadedAt = Date.now();
}
