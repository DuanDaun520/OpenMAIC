/**
 * Voice-override merge rules — pure and client-safe (no Node/DB imports), so
 * the admin console, the client voice picker, and the server agent catalog
 * all fold `voice_overrides` rows into registry presets identically.
 *
 * One row per (providerId, voiceId):
 *   - `hidden: true` removes the voice from every picker/catalog;
 *   - non-null fields override the preset's metadata (name / gender /
 *     language / description) — this is how a mislabeled catalog entry gets
 *     fixed without a code change;
 *   - a row whose voiceId is NOT a preset adds a brand-new selectable voice
 *     to that provider (appended after presets, in sortOrder then id order).
 *
 * Hiding is curatorial, not a synthesis ban: voices already bound by existing
 * courses keep synthesizing; pickers and the agent's list_voices simply stop
 * offering them.
 */

/** The wire/DB shape of one voice_overrides row (no secrets). */
export interface VoiceOverride {
  providerId: string;
  voiceId: string;
  name: string | null;
  language: string | null;
  gender: 'male' | 'female' | 'neutral' | null;
  description: string | null;
  hidden: boolean;
  sortOrder: number;
}

/** Minimal preset-voice shape the merge works on (registry voices qualify). */
export interface OverridableVoice {
  id: string;
  name: string;
  language?: string;
  gender?: 'male' | 'female' | 'neutral';
  description?: string;
}

/**
 * Fold one provider's override rows into its preset voice list. `overrides`
 * must already be filtered to this provider. Returns a new array; inputs are
 * not mutated. Non-preset rows append as additions (hidden additions are
 * dropped — an invisible custom voice has nothing to override).
 */
export function applyVoiceOverrides<V extends OverridableVoice>(
  presetVoices: readonly V[],
  overrides: readonly VoiceOverride[],
): V[] {
  const byVoiceId = new Map(overrides.map((row) => [row.voiceId, row]));

  const merged: V[] = [];
  for (const voice of presetVoices) {
    const row = byVoiceId.get(voice.id);
    if (row?.hidden) continue;
    if (!row) {
      merged.push(voice);
      continue;
    }
    merged.push({
      ...voice,
      ...(row.name ? { name: row.name } : {}),
      ...(row.language ? { language: row.language } : {}),
      ...(row.gender ? { gender: row.gender } : {}),
      ...(row.description ? { description: row.description } : {}),
    });
  }

  const presetIds = new Set(presetVoices.map((voice) => voice.id));
  const additions = overrides
    .filter((row) => !presetIds.has(row.voiceId) && !row.hidden)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.voiceId.localeCompare(b.voiceId));
  for (const row of additions) {
    merged.push({
      ...({} as V),
      id: row.voiceId,
      name: row.name || row.voiceId,
      ...(row.language ? { language: row.language } : {}),
      ...(row.gender ? { gender: row.gender } : {}),
      ...(row.description ? { description: row.description } : {}),
    });
  }

  return merged;
}
