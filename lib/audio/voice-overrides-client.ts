/**
 * Client-side cache of the admin voice overlay (/api/voice-overrides).
 *
 * `getEnabledProvidersWithVoices` is synchronous, so overrides flow through a
 * module-level snapshot it can read on every call — this module owns that
 * snapshot. `ensureVoiceOverridesLoaded()` (browser-only, TTL + in-flight
 * dedupe) keeps it fresh; `useVoiceOverridesVersion()` re-renders whichever
 * component owns the voice picker when a fetch lands, so the list doesn't wait
 * for an unrelated state change to pick the new rows up.
 */
import { useSyncExternalStore } from 'react';

import {
  type VoiceOverride,
  applyVoiceOverrides,
  type OverridableVoice,
} from './voice-override-rules';

const REFRESH_TTL_MS = 5 * 60_000;

let cachedRows: VoiceOverride[] = [];
let fetchedAt = 0;
let inflight: Promise<void> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render hook: bumps whenever a fetch lands new rows. */
export function useVoiceOverridesVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/**
 * Fetch the overlay (browser-only) and swap the cache. Idempotent and deduped;
 * re-fetches only after the TTL. Failures are swallowed — presets apply
 * unchanged when the console/DB is unreachable.
 */
export function ensureVoiceOverridesLoaded(force = false): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!force && Date.now() - fetchedAt < REFRESH_TTL_MS) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch('/api/voice-overrides');
      if (!response.ok) return;
      const body = (await response.json()) as { rows?: VoiceOverride[] };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (JSON.stringify(rows) !== JSON.stringify(cachedRows)) {
        cachedRows = rows;
        notify();
      }
      fetchedAt = Date.now();
    } catch {
      // Offline / dev server restarting — keep serving the last snapshot.
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** The client snapshot (empty until the first fetch resolves). */
export function getClientVoiceOverrides(): VoiceOverride[] {
  return cachedRows;
}

/** One provider's rows — what resolver call sites actually need. */
export function getProviderVoiceOverrides(providerId: string): VoiceOverride[] {
  return cachedRows.filter((row) => row.providerId === providerId);
}

/** Fold one provider's overlay into its presets (re-export for call sites). */
export function mergeProviderVoiceOverrides<V extends OverridableVoice>(
  providerId: string,
  presetVoices: readonly V[],
): V[] {
  return applyVoiceOverrides(presetVoices, getProviderVoiceOverrides(providerId));
}

/** Swap the cache directly — tests and other trusted writers. */
export function setClientVoiceOverrides(rows: VoiceOverride[]): void {
  cachedRows = rows;
  notify();
}
