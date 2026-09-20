/**
 * Background generation admission/ownership rules.
 *
 * Generation runs at module scope (the tab-wide RUN) so a course keeps
 * generating after its classroom page unmounts. Two pure decisions govern
 * the shared stage store: what a new generateRemaining call means against
 * the live run, and when a winding-down run may still write generation
 * status into the store.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  settingsState: vi.fn(),
  audioPut: vi.fn(),
  audioDelete: vi.fn(),
  poolPut: vi.fn(),
  poolReplace: vi.fn(),
  poolRemove: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
  pickNarratorAgent: vi.fn(),
  resolveAgentVoiceOptions: vi.fn(),
  listAgents: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: mocks.settingsState,
  },
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      put: mocks.audioPut,
      delete: mocks.audioDelete,
    },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.poolPut,
  replaceAsset: mocks.poolReplace,
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
}));

vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: mocks.pickNarratorAgent,
  resolveAgentVoiceOptions: mocks.resolveAgentVoiceOptions,
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: {
    getState: () => ({
      listAgents: mocks.listAgents,
    }),
  },
}));

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));

vi.stubGlobal('fetch', vi.fn());

describe('admitGenerationRun', () => {
  it('starts when no run is live', async () => {
    const { admitGenerationRun } = await import('@/lib/hooks/use-scene-generator');
    expect(admitGenerationRun({ generating: false, stageId: 'stage-a' }, 'stage-b')).toBe('start');
    expect(admitGenerationRun({ generating: false, stageId: null }, 'stage-a')).toBe('start');
  });

  it('joins a live run of the same course instead of starting a second loop', async () => {
    const { admitGenerationRun } = await import('@/lib/hooks/use-scene-generator');
    expect(admitGenerationRun({ generating: true, stageId: 'stage-a' }, 'stage-a')).toBe(
      'continue',
    );
  });

  it('supersedes a live run of another course (one shared stage store)', async () => {
    const { admitGenerationRun } = await import('@/lib/hooks/use-scene-generator');
    expect(admitGenerationRun({ generating: true, stageId: 'stage-a' }, 'stage-b')).toBe(
      'supersede',
    );
  });
});

describe('mayPresentGenerationStatus', () => {
  it('permits the newest run while the store still holds its epoch', async () => {
    const { mayPresentGenerationStatus } = await import('@/lib/hooks/use-scene-generator');
    expect(
      mayPresentGenerationStatus({
        runToken: 3,
        activeRunToken: 3,
        startEpoch: 7,
        currentEpoch: 7,
      }),
    ).toBe(true);
  });

  it('denies a superseded run: a successor owns the status presentation', async () => {
    const { mayPresentGenerationStatus } = await import('@/lib/hooks/use-scene-generator');
    expect(
      mayPresentGenerationStatus({
        runToken: 3,
        activeRunToken: 4,
        startEpoch: 7,
        currentEpoch: 7,
      }),
    ).toBe(false);
  });

  it('denies a run whose course was swapped out of the store (epoch bumped)', async () => {
    const { mayPresentGenerationStatus } = await import('@/lib/hooks/use-scene-generator');
    expect(
      mayPresentGenerationStatus({
        runToken: 3,
        activeRunToken: 3,
        startEpoch: 7,
        currentEpoch: 8,
      }),
    ).toBe(false);
  });
});
