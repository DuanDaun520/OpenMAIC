/**
 * snapshotPresetRoster: the generation-time freeze of a preset lineup onto
 * the stage document. The frozen records must carry the preset agents' own
 * portrait/persona AND the voice binding each agent would speak with at that
 * moment (the teacher's global narrator voice; classmates' overrides or
 * deterministic picks), under stage-scoped ids that cannot shadow the shared
 * default agents.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A working window.localStorage before the stores import (see
// apply-generated-agents.test.ts for why the persist middleware needs it).
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const localStorageStub: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageStub,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
  });
});

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

vi.mock('@/lib/audio/agent-voice', () => ({
  warmUpAgentVoices: vi.fn(),
}));

import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useSettingsStore } from '@/lib/store/settings';
import { snapshotPresetRoster } from '@/lib/orchestration/registry/preset-roster-snapshot';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

const STAGE_ID = 'stage_abc123';

function seedDefaultAgents() {
  const now = new Date();
  const base = {
    allowedActions: [],
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
  useAgentRegistry.setState({
    agents: {
      'default-1': {
        ...base,
        id: 'default-1',
        name: 'AI teacher',
        role: 'teacher',
        persona: 'Lead teacher',
        avatar: '/avatars/teacher-3-f.png',
        color: '#3b82f6',
        priority: 10,
      },
      'default-3': {
        ...base,
        id: 'default-3',
        name: '小趣',
        role: 'student',
        persona: 'Meme buddy',
        avatar: '/avatars/student-1.png',
        color: '#f59e0b',
        priority: 4,
      },
    },
  });
}

/** Enable one deterministic server provider with two voices. */
function seedTtsSettings() {
  useSettingsStore.setState((state) => ({
    ttsProviderId: 'openai-tts',
    ttsVoice: 'nova',
    ttsProvidersConfig: {
      ...state.ttsProvidersConfig,
      'openai-tts': { ...state.ttsProvidersConfig['openai-tts'], apiKey: 'k', enabled: true },
    },
    agentVoiceOverrides: {
      'default-3': { providerId: 'openai-tts', voiceId: 'onyx' },
    },
  }));
}

beforeEach(() => {
  seedDefaultAgents();
  seedTtsSettings();
});

describe('snapshotPresetRoster', () => {
  it('freezes portrait/persona and the effective voices under stage-scoped ids', () => {
    const roster = snapshotPresetRoster({
      stageId: STAGE_ID,
      selectedAgentIds: ['default-1', 'default-3'],
    });

    const byRole = Object.fromEntries(roster.map((a) => [a.role, a]));
    // Teacher: the global narrator voice at generation time.
    expect(byRole.teacher).toMatchObject({
      id: `preset-${STAGE_ID}-default-1`,
      avatar: '/avatars/teacher-3-f.png',
      persona: 'Lead teacher',
      voiceConfig: { providerId: 'openai-tts', voiceId: 'nova' },
    });
    // Classmate: her persisted per-agent override.
    expect(byRole.student).toMatchObject({
      id: `preset-${STAGE_ID}-default-3`,
      avatar: '/avatars/student-1.png',
      voiceConfig: { providerId: 'openai-tts', voiceId: 'onyx' },
    });
  });

  it('drops unknown and generated ids, and guarantees a teacher', () => {
    useAgentRegistry.setState((state) => ({
      agents: {
        ...state.agents,
        'gen-old': {
          ...state.agents['default-3'],
          id: 'gen-old',
          isGenerated: true,
          boundStageId: 'other',
        },
      },
    }));

    const roster = snapshotPresetRoster({
      stageId: STAGE_ID,
      // No teacher in the selection, one stale generated id.
      selectedAgentIds: ['default-3', 'gen-old', 'missing-agent'],
    });

    expect(roster.map((a) => a.id)).toEqual([
      `preset-${STAGE_ID}-default-1`,
      `preset-${STAGE_ID}-default-3`,
    ]);
    expect(roster[0].role).toBe('teacher');
  });

  it('omits the teacher voiceConfig when the global narrator voice is unusable', () => {
    useSettingsStore.setState({
      ttsProviderId: 'openai-tts',
      ttsVoice: undefined,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);

    const roster = snapshotPresetRoster({
      stageId: STAGE_ID,
      selectedAgentIds: ['default-1'],
    });

    const record: GeneratedAgentConfig = {
      id: `preset-${STAGE_ID}-default-1`,
      name: 'AI teacher',
      role: 'teacher',
      persona: 'Lead teacher',
      avatar: '/avatars/teacher-3-f.png',
      color: '#3b82f6',
      priority: 10,
    };
    // No voiceConfig key at all — the live TTS fallback stays in charge.
    expect(roster[0]).toEqual(record);
  });
});
