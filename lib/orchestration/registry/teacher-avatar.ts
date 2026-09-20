'use client';

/**
 * Teacher-avatar ↔ narration-voice gender sync.
 *
 * The default teacher ships a male avatar, but the narration voice is whatever
 * the TTS settings resolve to — a female voice with a male portrait reads as a
 * mismatch. This module infers the resolved narrator voice's gender and swaps
 * the default teacher's avatar to its female counterpart (and back) so the
 * portrait always matches the voice a course actually narrates with.
 *
 * The swap is display-layer only: it writes the in-memory registry (whose
 * persisted snapshot drops `default-*` entries on merge), so it never outlives
 * the session and is re-derived from settings on every load. A generated
 * classroom's teacher (LLM-chosen avatar + binding) is deliberately untouched.
 */

import { useEffect } from 'react';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { pickNarratorAgent } from '@/lib/audio/agent-voice';
import { isVoiceBindingUnavailable } from '@/lib/audio/unavailable-voice-bindings';
import { resolveNarratorVoiceBinding } from '@/lib/audio/voice-resolver';
import {
  ensureVoiceOverridesLoaded,
  getProviderVoiceOverrides,
  useVoiceOverridesVersion,
} from '@/lib/audio/voice-overrides-client';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';

/** The two default-teacher portraits (male / female), same flat-vector style. */
export const TEACHER_AVATAR_MALE = '/avatars/teacher-3.png';
export const TEACHER_AVATAR_FEMALE = '/avatars/teacher-3-f.png';

function inferGenderFromText(text: string): 'male' | 'female' | undefined {
  const t = text.toLowerCase();
  // 'female' first — it contains 'male', so the order decides.
  if (t.includes('female') || t.includes('女')) return 'female';
  if (t.includes('male') || t.includes('男')) return 'male';
  return undefined;
}

/**
 * Best-effort gender of a TTS voice: the provider registry's own metadata
 * first (openai/azure/doubao/qwen presets carry it), then id/design heuristics
 * (`zh_female_…`, a voiceDesign identity like "middle-aged male teacher").
 * Returns undefined when nothing gendered can be inferred — the caller then
 * keeps the current avatar rather than guessing.
 */
export function inferVoiceGender(
  providerId: string,
  voiceId: string,
  designIdentity?: string,
): 'male' | 'female' | undefined {
  // The admin overlay outranks the shipped registry: a corrected gender in the
  // console is the operator saying the catalog entry was wrong (and hiding
  // here would make the voice unpickable anyway, so only gender matters).
  const overrideRow = getProviderVoiceOverrides(providerId).find((row) => row.voiceId === voiceId);
  if (overrideRow?.gender === 'female' || overrideRow?.gender === 'male') {
    return overrideRow.gender;
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const preset = provider?.voices.find((voice) => voice.id === voiceId);
  if (preset?.gender === 'female' || preset?.gender === 'male') return preset.gender;
  return inferGenderFromText(`${voiceId} ${designIdentity ?? ''}`);
}

/** The narrator voice the current settings + registry would narrate with. */
function resolvedNarratorVoice() {
  const registry = useAgentRegistry.getState();
  const settings = useSettingsStore.getState();
  const narrator = pickNarratorAgent(registry.listAgents());
  const bound = narrator?.voiceConfig;
  const globalProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  return resolveNarratorVoiceBinding(
    bound && !isVoiceBindingUnavailable(bound) ? bound : undefined,
    {
      providerId: settings.ttsProviderId,
      modelId: globalProviderConfig?.modelId,
      voiceId: settings.ttsVoice,
    },
    settings.ttsProvidersConfig ?? {},
  );
}

/**
 * Point the default teacher's avatar at the portrait matching the resolved
 * narration voice's gender. No-op when the gender is unknown (browser-native
 * default, neutral voices) — the male portrait stays, as before.
 */
export function syncDefaultTeacherAvatarToVoice(): void {
  if (typeof window === 'undefined') return;
  const registry = useAgentRegistry.getState();
  const teacher = registry.agents['default-1'];
  if (!teacher) return;

  const narrator = pickNarratorAgent(registry.listAgents());
  const resolved = resolvedNarratorVoice();
  const gender = inferVoiceGender(
    resolved.providerId,
    resolved.voiceId,
    narrator?.voiceDesign?.identity,
  );
  const target =
    gender === 'female'
      ? TEACHER_AVATAR_FEMALE
      : gender === 'male'
        ? TEACHER_AVATAR_MALE
        : undefined;
  if (target && teacher.avatar !== target) {
    registry.updateAgent('default-1', { avatar: target });
  }
}

/**
 * Keep the default teacher's portrait matched to the narration voice for the
 * lifetime of the mounting surface (homepage, classroom). Re-derives on every
 * settings/registry change — the same resolution path narration itself uses,
 * so portrait and voice cannot disagree for long.
 */
export function useTeacherAvatarVoiceSync(): void {
  // Re-derive when the admin voice overlay lands (a gender fix changes the
  // target portrait) — the version subscription re-runs the effect below.
  const overlayVersion = useVoiceOverridesVersion();
  useEffect(() => {
    void ensureVoiceOverridesLoaded();
    syncDefaultTeacherAvatarToVoice();
    const unsubscribeSettings = useSettingsStore.subscribe(syncDefaultTeacherAvatarToVoice);
    const unsubscribeRegistry = useAgentRegistry.subscribe(syncDefaultTeacherAvatarToVoice);
    return () => {
      unsubscribeSettings();
      unsubscribeRegistry();
    };
  }, [overlayVersion]);
}
