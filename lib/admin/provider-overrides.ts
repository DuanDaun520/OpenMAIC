/**
 * DB-first provider configuration overlay.
 *
 * `provider-config.ts` is fully synchronous (env + YAML, process-cached), but
 * database reads are async. This module bridges the two: it owns a small
 * in-memory snapshot of `provider_configs` rows that is loaded in the
 * background and consumed synchronously by `getConfig()`. Consistency model:
 *
 * - Reads: last-loaded snapshot. The very first request of a process may land
 *   before the first load completes and see env/YAML only; the snapshot
 *   refreshes every {@link OVERLAY_TTL_MS}, so the DB view follows within
 *   seconds.
 * - Writes: the admin API patches the snapshot synchronously (write-through)
 *   before returning, so the console sees its own writes immediately, then
 *   also persists them; other processes converge on the next TTL refresh.
 *
 * Every `getConfig()` rebuild is keyed on a monotonic snapshot version, so a
 * background reload invalidates the provider-config cache exactly once per
 * change.
 */
import { decryptSecret } from '@/lib/admin/crypto';
import { getAdminPool } from '@/lib/admin/db';

/** Capability dimension of `provider_configs`. `llm` maps to the
 * `providers` section; `pdf` to `pdf`; the rest map 1:1. */
export const ADMIN_CAPABILITIES = [
  'llm',
  'tts',
  'asr',
  'pdf',
  'image',
  'video',
  'websearch',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export interface ProviderConfigRow {
  capability: AdminCapability;
  providerId: string;
  apiKeyCipher: string | null;
  baseUrl: string | null;
  models: string[];
  proxy: string | null;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

interface OverlaySnapshot {
  version: number;
  loadedAt: number;
  rows: ProviderConfigRow[];
}

const OVERLAY_TTL_MS = 10_000;
const FAILURE_RETRY_MS = 5_000;

let snapshot: OverlaySnapshot | null = null;
let loading: Promise<void> | undefined;
let lastFailureAt = 0;

async function loadOverlay(): Promise<void> {
  const pool = await getAdminPool();
  const result = await pool.query<{
    capability: string;
    provider_id: string;
    api_key_cipher: string | null;
    base_url: string | null;
    models: string[] | null;
    proxy: string | null;
    enabled: boolean;
    updated_by: string | null;
    updated_at: Date;
  }>(`SELECT capability, provider_id, api_key_cipher, base_url, models, proxy, enabled, updated_by, updated_at
       FROM provider_configs`);
  const rows: ProviderConfigRow[] = result.rows.map((row) => ({
    capability: row.capability as AdminCapability,
    providerId: row.provider_id,
    apiKeyCipher: row.api_key_cipher,
    baseUrl: row.base_url,
    models: Array.isArray(row.models) ? row.models : [],
    proxy: row.proxy,
    enabled: row.enabled,
    updatedBy: row.updated_by,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
  // Bump the version (and thus invalidate every getConfig() cache) only when
  // the content actually changed — a routine TTL refresh on identical rows
  // must not churn the provider-config rebuild or its log line.
  if (snapshot && JSON.stringify(rows) === JSON.stringify(snapshot.rows)) {
    snapshot = { ...snapshot, loadedAt: Date.now() };
    return;
  }
  snapshot = { version: (snapshot?.version ?? 0) + 1, loadedAt: Date.now(), rows };
}

/**
 * Kick off a background reload when the snapshot is missing or older than the
 * TTL. Never throws: failures are logged and retried after a short backoff,
 * leaving the last good snapshot (possibly none) in place.
 */
export function ensureAdminProviderOverlayFresh(): void {
  const age = snapshot ? Date.now() - snapshot.loadedAt : Infinity;
  const backoff = snapshot ? OVERLAY_TTL_MS : FAILURE_RETRY_MS;
  if (loading || Date.now() - lastFailureAt < backoff || age < backoff) return;
  loading = loadOverlay()
    .catch((error) => {
      lastFailureAt = Date.now();
      console.error(
        '[admin] provider-config overlay load failed; serving previous snapshot',
        error,
      );
    })
    .finally(() => {
      loading = undefined;
    });
}

/** Current snapshot version — 0 when nothing has loaded yet. */
export function getAdminProviderOverlayVersion(): number {
  return snapshot?.version ?? 0;
}

export function getAdminProviderOverlaySync(): OverlaySnapshot | null {
  return snapshot;
}

/**
 * Force a load (deduped with any in-flight refresh) and return the rows.
 * Admin API uses this instead of the TTL-fed sync snapshot so its listings
 * are current as of the request.
 */
export async function loadProviderConfigRows(): Promise<ProviderConfigRow[]> {
  if (!loading) {
    loading = loadOverlay()
      .catch((error) => {
        lastFailureAt = Date.now();
        console.error('[admin] provider-config overlay load failed', error);
      })
      .finally(() => {
        loading = undefined;
      });
  }
  await loading;
  return snapshot?.rows ?? [];
}

/** All DB rows with API keys decrypted. Admin API only — never a client surface. */
export function listProviderConfigRows(): ProviderConfigRow[] {
  return snapshot?.rows ?? [];
}

export function getProviderConfigRow(
  capability: AdminCapability,
  providerId: string,
): ProviderConfigRow | undefined {
  return snapshot?.rows.find(
    (row) => row.capability === capability && row.providerId === providerId,
  );
}

/** Decrypted API key for a row, for admin display or takeover flows. */
export function decryptRowApiKey(row: ProviderConfigRow): string {
  return decryptSecret(row.apiKeyCipher);
}

/**
 * Write-through patch: update (or remove) one row in the in-memory snapshot
 * and bump the version, so the next `getConfig()` rebuild picks it up without
 * waiting for the TTL refresh. Call after the DB write commits.
 */
export function patchProviderConfigRow(
  row: ProviderConfigRow | null,
  key: { capability: AdminCapability; providerId: string },
): void {
  if (!snapshot) {
    // Nothing loaded yet — force the next refresh instead of synthesizing a
    // partial snapshot.
    snapshot = { version: 0, loadedAt: 0, rows: [] };
  }
  const others = snapshot.rows.filter(
    (existing) =>
      !(existing.capability === key.capability && existing.providerId === key.providerId),
  );
  snapshot.rows = row ? [...others, row] : others;
  snapshot.version += 1;
  snapshot.loadedAt = Date.now();
}
