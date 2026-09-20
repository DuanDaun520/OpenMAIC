import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stage-storage modules are imported dynamically inside the store's save/load
// actions. Mock them so nothing in the test environment reaches IndexedDB.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function makeStage(): Stage {
  return { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 };
}

function makeSlideScene(order: number): Scene {
  return {
    id: `scene-${order}`,
    stageId: 'stage-1',
    type: 'slide',
    title: `scene ${order}`,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${order}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  } as Scene;
}

function makeOutline(order: number): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: `outline ${order}`,
    description: 'desc',
    keyPoints: ['k1'],
    order,
  };
}

const STALE_MS = 3 * 60_000;
const INTERRUPTED_REASON = '生成已中断（测试）';

interface GenerationMetaInput {
  heartbeatAt: number | null;
  error: string | null;
  nowMs: number;
  interruptedReason: string;
  staleMs: number;
}

/** Load-shaped state: outline 2 pending, deck not complete. */
function pendingDeck() {
  useStageStore.setState({
    stage: makeStage(),
    scenes: [makeSlideScene(1)],
    outlines: [makeOutline(1), makeOutline(2)],
    generationComplete: false,
    generatingOutlines: [makeOutline(2)],
    failedOutlines: [],
    generationStatus: 'idle',
    generationError: null,
    generationInterrupted: false,
  });
}

function applyMeta(overrides: Partial<GenerationMetaInput> = {}) {
  useStageStore.getState().applyGenerationMeta({
    heartbeatAt: null,
    error: null,
    nowMs: 1_000_000,
    interruptedReason: INTERRUPTED_REASON,
    staleMs: STALE_MS,
    ...overrides,
  });
}

beforeEach(() => {
  useStageStore.getState().clearStore();
});

afterEach(() => {
  useStageStore.getState().clearStore();
});

describe('applyGenerationMeta — the interrupted-generation seed', () => {
  it('seeds pending outlines as failed with the interrupted reason when no heartbeat ever landed', () => {
    pendingDeck();
    applyMeta();

    // The pending outline moved into failedOutlines (deduped), so the failed
    // surfaces — overlay, sidebar, retry — render instead of the spinner.
    expect(useStageStore.getState().failedOutlines.map((o) => o.order)).toEqual([2]);
    expect(useStageStore.getState().generationError).toBe(INTERRUPTED_REASON);
    expect(useStageStore.getState().generationInterrupted).toBe(true);
  });

  it('prefers a recorded server error over the generic interrupted reason', () => {
    pendingDeck();
    applyMeta({ error: 'Provider quota exceeded (429)' });

    expect(useStageStore.getState().generationError).toBe('Provider quota exceeded (429)');
    expect(useStageStore.getState().generationInterrupted).toBe(false);
  });

  it('keeps the spinner when the heartbeat is fresh — a live tab is generating', () => {
    pendingDeck();
    const nowMs = 1_000_000;
    applyMeta({ heartbeatAt: nowMs - 30_000, nowMs });

    expect(useStageStore.getState().failedOutlines).toEqual([]);
    expect(useStageStore.getState().generationInterrupted).toBe(false);
  });

  it('treats a heartbeat barely past the window as stale (clock-skew margin)', () => {
    pendingDeck();
    const nowMs = 1_000_000;
    applyMeta({ heartbeatAt: nowMs - STALE_MS - 1, nowMs });

    expect(useStageStore.getState().failedOutlines.map((o) => o.order)).toEqual([2]);
  });

  it('does not seed while a local run is generating', () => {
    pendingDeck();
    useStageStore.setState({ generationStatus: 'generating' });
    applyMeta();

    expect(useStageStore.getState().failedOutlines).toEqual([]);
  });

  it('does not seed a completed deck (orphaned outlines after edits)', () => {
    useStageStore.setState({
      stage: makeStage(),
      scenes: [makeSlideScene(1), makeSlideScene(2)],
      outlines: [makeOutline(1), makeOutline(2)],
      generationComplete: true,
      generatingOutlines: [],
    });
    applyMeta();

    expect(useStageStore.getState().failedOutlines).toEqual([]);
    expect(useStageStore.getState().generationError).toBeNull();
  });

  it('does not flatten a local failure reason on a re-seed', () => {
    pendingDeck();
    const local = 'TTS request failed: voice unavailable';
    useStageStore.setState({ generationError: local });
    applyMeta();

    // No server error on record and a local reason exists: the local reason
    // wins and the presentation stays "failed", not "interrupted".
    expect(useStageStore.getState().generationError).toBe(local);
    expect(useStageStore.getState().generationInterrupted).toBe(false);
  });

  it('does not duplicate an outline already recorded as failed', () => {
    pendingDeck();
    useStageStore.setState({ failedOutlines: [makeOutline(2)] });
    applyMeta({ error: 'server error' });

    expect(useStageStore.getState().failedOutlines).toHaveLength(1);
    expect(useStageStore.getState().generationError).toBe('server error');
  });
});

describe('generation failure presentation reset', () => {
  it('addFailedOutline records the reason alongside the outline', () => {
    useStageStore.setState({ failedOutlines: [], generationError: null });
    useStageStore
      .getState()
      .addFailedOutline(makeOutline(2), 'Actions generation failed: HTTP 500');

    expect(useStageStore.getState().failedOutlines.map((o) => o.order)).toEqual([2]);
    expect(useStageStore.getState().generationError).toBe('Actions generation failed: HTTP 500');
    expect(useStageStore.getState().generationInterrupted).toBe(false);
  });

  it('clearGenerationFailure resets reason and interrupted flag', () => {
    useStageStore.setState({ generationError: 'boom', generationInterrupted: true });
    useStageStore.getState().clearGenerationFailure();
    expect(useStageStore.getState().generationError).toBeNull();
    expect(useStageStore.getState().generationInterrupted).toBe(false);
  });

  it('clearStore resets the generation-signal fields', () => {
    useStageStore.setState({ generationError: 'boom', generationInterrupted: true });
    useStageStore.getState().clearStore();
    expect(useStageStore.getState().generationError).toBeNull();
    expect(useStageStore.getState().generationInterrupted).toBe(false);
    expect(useStageStore.getState().generationHeartbeatAt).toBeNull();
  });
});
