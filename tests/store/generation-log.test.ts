/**
 * The courseware AI production log store: per-stage append with caps, and the
 * 清空 action. Persisted through the KVStore `account` scope — the harness
 * stubs localStorage and imports the store per-test so the persist
 * rehydration path is exercised for real, mirroring the settings-store tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const persistKv = new BrowserKVStore({ storage: localStorageStub as unknown as Storage });

async function freshStore(seed?: Record<string, unknown>) {
  vi.resetModules();
  // A prior test's store instance may still have a persist write queued. Let
  // those microtask chains land before wiping storage, or the stale blob can
  // race this instance's rehydrate and resurrect the previous test's entries.
  await new Promise((resolve) => setTimeout(resolve, 0));
  storage.clear();
  if (seed) {
    await persistKv.set('generation-log-storage', seed, 'account');
  }
  const { useGenerationLogStore } = await import('@/lib/store/generation-log');
  await useGenerationLogStore.persist.rehydrate();
  return useGenerationLogStore;
}

function appendN(
  store: Awaited<ReturnType<typeof freshStore>>,
  stageId: string,
  n: number,
  baseAt = 1_000,
) {
  for (let i = 0; i < n; i++) {
    store.getState().appendGenerationLog(stageId, {
      level: 'info',
      phase: 'content',
      message: `entry-${i}`,
      at: baseAt + i,
    });
  }
}

describe('useGenerationLogStore', () => {
  beforeEach(() => storage.clear());

  it('appends an entry with id/at filled in and scene fields preserved', async () => {
    const store = await freshStore();
    store.getState().appendGenerationLog('stage-1', {
      level: 'error',
      phase: 'content',
      message: '第 2 页「标题」内容生成失败：boom',
      sceneOrder: 2,
      sceneTitle: '标题',
    });
    const entries = store.getState().logsByStage['stage-1'];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      phase: 'content',
      message: '第 2 页「标题」内容生成失败：boom',
      sceneOrder: 2,
      sceneTitle: '标题',
      at: expect.any(Number) as number,
    });
    expect(typeof entries[0].id).toBe('string');
    expect(entries[0].id).not.toBe('');
  });

  it('caps one stage at 300 entries, keeping the newest', async () => {
    const store = await freshStore();
    appendN(store, 'stage-1', 305);
    const entries = store.getState().logsByStage['stage-1'];
    expect(entries).toHaveLength(300);
    expect(entries[0].message).toBe('entry-5');
    expect(entries[299].message).toBe('entry-304');
  });

  it('keeps entries ordered oldest → newest as appended', async () => {
    const store = await freshStore();
    appendN(store, 'stage-1', 3);
    const entries = store.getState().logsByStage['stage-1'];
    expect(entries.map((e) => e.message)).toEqual(['entry-0', 'entry-1', 'entry-2']);
    expect(entries.map((e) => e.at)).toEqual([1000, 1001, 1002]);
  });

  it('clearStageGenerationLog drops the stage and leaves others alone', async () => {
    const store = await freshStore();
    appendN(store, 'stage-1', 1);
    appendN(store, 'stage-2', 1);
    store.getState().clearStageGenerationLog('stage-1');
    expect(store.getState().logsByStage['stage-1']).toBeUndefined();
    expect(store.getState().logsByStage['stage-2']).toHaveLength(1);
    // Clearing an unknown stage is a no-op, not a crash.
    store.getState().clearStageGenerationLog('nope');
    expect(store.getState().logsByStage['stage-2']).toHaveLength(1);
  });

  it('evicts the stalest other stage when a 21st course starts logging', async () => {
    const store = await freshStore();
    // 20 stages, written in order so stage-old-0 is the stalest.
    for (let i = 0; i < 20; i++) {
      appendN(store, `stage-old-${i}`, 1, 1_000 + i);
    }
    appendN(store, 'stage-new', 1, 9_999);
    const logs = store.getState().logsByStage;
    expect(logs['stage-old-0']).toBeUndefined();
    expect(logs['stage-old-1']).toHaveLength(1);
    expect(logs['stage-new']).toHaveLength(1);
  });

  it('persists appended entries through the KV account scope', async () => {
    const store = await freshStore();
    appendN(store, 'stage-1', 2);
    await vi.waitFor(async () => {
      const blob = await persistKv.get<{
        state: { logsByStage: Record<string, unknown[]> };
      }>('generation-log-storage', 'account');
      expect(blob).not.toBeNull();
      expect(blob!.state.logsByStage['stage-1']).toHaveLength(2);
    });
  });

  it('rehydrates a previously persisted log for a stage', async () => {
    const seeded = {
      state: {
        logsByStage: {
          'stage-1': [
            {
              id: 'a',
              at: 123,
              level: 'success',
              phase: 'completed',
              message: '全部 3 页制作完成',
            },
          ],
        },
      },
      version: 1,
    };
    const store = await freshStore(seeded);
    expect(store.getState().logsByStage['stage-1']).toEqual([
      { id: 'a', at: 123, level: 'success', phase: 'completed', message: '全部 3 页制作完成' },
    ]);
    // And appends after rehydration extend rather than replace it.
    store.getState().appendGenerationLog('stage-1', {
      level: 'info',
      phase: 'start',
      message: 'again',
      at: 456,
    });
    expect(store.getState().logsByStage['stage-1']).toHaveLength(2);
  });
});
