/**
 * Client-side phase timing (#observability): fetch results carry the true
 * HTTP wall-clock (including retries) as durationMs, the {{duration}} text is
 * locale-neutral, and the TTS POST body names the course so server-side
 * generation_trace rows correlate with the deck.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';

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

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Timed Scene',
  description: 'Phase timing',
  keyPoints: ['timing'],
  order: 2,
} as SceneOutline;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
  };
}

describe('scene generation phase timing', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset().mockResolvedValue('ast_audio_allocated');
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: {
        'server-tts': {
          apiKey: 'tts-key',
          modelId: 'tts-model',
        },
      },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
    });
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
  });

  describe('formatPhaseDuration', () => {
    it('renders locale-neutral durations: 823ms / 12.3s / 4m05s', async () => {
      const { formatPhaseDuration } = await import('@/lib/hooks/use-scene-generator');
      expect(formatPhaseDuration(823)).toBe('823ms');
      expect(formatPhaseDuration(12_345)).toBe('12.3s');
      expect(formatPhaseDuration(245_000)).toBe('4m05s');
    });
  });

  describe('fetchSceneContent / fetchSceneActions', () => {
    it('reports the fetch wall-clock on success, retries included', async () => {
      const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
      mockFetch
        .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }))
        .mockResolvedValueOnce(jsonResponse(200, { success: true, content: { elements: [] } }));

      const result = await fetchSceneContent(
        {
          outline,
          allOutlines: [outline],
          stageId: 'stage-1',
          stageInfo: { name: 'Timed Course' },
        },
        undefined,
        { maxRetries: 1, sleep: async () => undefined, random: () => 0 },
      );

      expect(result).toMatchObject({ success: true, content: { elements: [] } });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports the wall-clock on permanent failure too (failed calls stay measurable)', async () => {
      const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
      mockFetch.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

      const result = await fetchSceneContent(
        {
          outline,
          allOutlines: [outline],
          stageId: 'stage-1',
          stageInfo: { name: 'Timed Course' },
        },
        undefined,
        { maxRetries: 0, sleep: async () => undefined, random: () => 0 },
      );

      expect(result).toMatchObject({ success: false });
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports the wall-clock for scene actions', async () => {
      const { fetchSceneActions } = await import('@/lib/hooks/use-scene-generator');
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, scene: { id: 'scene-1' }, previousSpeeches: [] }),
      );

      const result = await fetchSceneActions(
        {
          outline,
          allOutlines: [outline],
          content: { elements: [] },
          stageId: 'stage-1',
        },
        undefined,
        { maxRetries: 0, sleep: async () => undefined, random: () => 0 },
      );

      expect(result).toMatchObject({ success: true });
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('generateAndStoreTTS', () => {
    it('sends stageId in the POST body so the server can correlate trace rows', async () => {
      const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, base64: btoa('audio-data'), format: 'wav' }),
      );

      const audioId = await generateAndStoreTTS(
        'tts_timed_action_1',
        'Hello class',
        'English',
        undefined,
        undefined,
        undefined,
        'stage-trace-1',
      );

      expect(audioId).toBe('tts_timed_action_1');
      const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
      expect(body.stageId).toBe('stage-trace-1');
    });

    it('omits the stageId key entirely when absent (older callers)', async () => {
      const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, base64: btoa('audio-data'), format: 'wav' }),
      );

      await generateAndStoreTTS('tts_timed_action_2', 'Hello class');
      const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
      expect('stageId' in body).toBe(false);
    });
  });
});
