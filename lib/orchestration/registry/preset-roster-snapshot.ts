'use client';

/**
 * Freeze the selected preset lineup into a stage-owned roster.
 *
 * A preset-mode generation used to record only `stage.agentIds` — bare
 * references to the GLOBAL default agents. The teacher's portrait and every
 * agent's voice were then re-resolved at each classroom open from whatever the
 * global registry/settings held at that moment, so a later 预设AI老师与同学
 * change on the homepage (e.g. picking a 男老师 voice, which also swaps the
 * default teacher's portrait) retroactively changed every already-generated
 * course. Voice and portrait are properties of the COURSE, not of whoever
 * opens it.
 *
 * `snapshotPresetRoster` closes the gap at the only moment the truth exists —
 * generation time: it copies the currently selected preset agents (portrait,
 * color, persona, priority) and their EFFECTIVE voice bindings (the teacher's
 * global narrator voice; each classmate's override or deterministic pick)
 * into `GeneratedAgentConfig` records bound to the stage. Written to
 * `stage.generatedAgentConfigs`, they ride the ordinary generated-roster
 * machinery: the classroom hydrates the registry from the document and plays
 * the course's own cast forever after.
 *
 * Minted ids are stage-scoped (`preset-<stageId>-<agentId>`) so the snapshot
 * never collides with — or shadows — the shared default agents in the
 * registry. Voice bindings that cannot be served right now are simply
 * omitted: the live TTS fallback machinery keeps working exactly as before.
 */
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  getEnabledProvidersWithVoices,
  resolveAgentVoice,
  resolveNarratorVoiceForGeneration,
  type AgentVoiceOverrides,
  type ProviderWithVoices,
  type UserVoiceProfile,
} from '@/lib/audio/voice-resolver';
import type { TTSProviderId } from '@/lib/audio/types';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useSettingsStore } from '@/lib/store/settings';

export function snapshotPresetRoster(params: {
  stageId: string;
  /** The preset agent ids selected for this course (unknown ids are dropped). */
  selectedAgentIds: string[];
  /** Clone-voice profiles, so custom voices resolve exactly as the picker shows them. */
  voiceProfiles?: UserVoiceProfile[];
}): GeneratedAgentConfig[] {
  const { stageId, selectedAgentIds, voiceProfiles = [] } = params;
  const registry = useAgentRegistry.getState();
  const settings = useSettingsStore.getState();

  const selected = selectedAgentIds
    .map((id) => registry.getAgent(id))
    .filter((agent): agent is NonNullable<typeof agent> => !!agent && !agent.isGenerated);

  // A classroom always needs its teacher: the AgentBar keeps the default
  // teacher permanently checked, but a stale/filtered selection must not be
  // able to mint a teacherless course.
  if (!selected.some((agent) => agent.role === 'teacher')) {
    const teacher = registry
      .listAgents()
      .find((agent) => !agent.isGenerated && agent.role === 'teacher');
    if (teacher) selected.unshift(teacher);
  }

  const enabledProviders = getEnabledProvidersWithVoices(settings.ttsProvidersConfig, voiceProfiles);

  return selected.map((agent, index) => ({
    id: `preset-${stageId}-${agent.id}`,
    name: agent.name,
    role: agent.role,
    persona: agent.persona || '',
    avatar: agent.avatar,
    color: agent.color,
    priority: agent.priority ?? 0,
    ...voiceConfigFor(agent, index, {
      narratorProviderId: settings.ttsProviderId,
      narratorVoiceId: settings.ttsVoice,
      narratorProviderConfig: settings.ttsProvidersConfig[settings.ttsProviderId],
      enabledProviders,
      overrides: settings.agentVoiceOverrides,
    }),
  }));
}

/** The effective voice binding to freeze for one agent, if any. */
function voiceConfigFor(
  agent: AgentConfig,
  index: number,
  ctx: {
    narratorProviderId: TTSProviderId;
    narratorVoiceId: string | undefined;
    narratorProviderConfig: { modelId?: string } | undefined;
    enabledProviders: ProviderWithVoices[];
    overrides: AgentVoiceOverrides | undefined;
  },
): { voiceConfig?: GeneratedAgentConfig['voiceConfig'] } {
  // The teacher IS the narrator: their voice is the global teacher voice the
  // homepage pill writes (there is no per-teacher override slot). Classmates
  // resolve through the same picker logic discussion TTS uses.
  const resolved =
    agent.role === 'teacher'
      ? resolveNarratorVoiceForGeneration(
          ctx.narratorProviderId,
          ctx.narratorVoiceId,
          ctx.narratorProviderConfig,
        )
      : resolveAgentVoice(agent, index, ctx.enabledProviders, ctx.overrides);
  if (!resolved) return {};
  return {
    voiceConfig: {
      providerId: resolved.providerId,
      ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
      voiceId: resolved.voiceId,
    },
  };
}
