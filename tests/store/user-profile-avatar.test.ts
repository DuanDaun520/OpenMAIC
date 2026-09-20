/**
 * The user-profile avatar migration (v1): the default learner portrait moved
 * to the flat-vector roster style. Only the exact old default is remapped —
 * an explicitly picked avatar keeps its file.
 *
 * Harness mirrors persisted-store-scopes.test: a localStorage Map stub behind
 * BrowserKVStore, with the store imported per-test after vi.resetModules so
 * the persist rehydration path runs for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const backing = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (k: string) => backing.get(k) ?? null,
  key: (i: number) => [...backing.keys()][i] ?? null,
  removeItem: (k: string) => void backing.delete(k),
  setItem: (k: string, v: string) => void backing.set(k, v),
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const kv = new BrowserKVStore({ storage: localStorageStub });

async function freshProfile(seeded?: Record<string, unknown>) {
  vi.resetModules();
  await new Promise((resolve) => setTimeout(resolve, 0));
  backing.clear();
  if (seeded) {
    await kv.set('user-profile-storage', seeded, 'account');
  }
  const { useUserProfileStore, AVATAR_OPTIONS } = await import('@/lib/store/user-profile');
  await useUserProfileStore.persist.rehydrate();
  return { store: useUserProfileStore, defaults: AVATAR_OPTIONS };
}

beforeEach(() => {
  backing.clear();
});

describe('user profile avatar migration', () => {
  it('remaps the old default avatar to the new flat-style default', async () => {
    const { store, defaults } = await freshProfile({
      state: { avatar: '/avatars/user.png', nickname: 'Ada', bio: '' },
      version: 0,
    });
    expect(store.getState().avatar).toBe(defaults[0]);
    expect(store.getState().nickname).toBe('Ada');
  });

  it('keeps an explicitly picked (non-default) avatar as-is', async () => {
    const { store } = await freshProfile({
      state: { avatar: '/avatars/teacher-2.png', nickname: 'Ada', bio: '' },
      version: 0,
    });
    expect(store.getState().avatar).toBe('/avatars/teacher-2.png');
  });

  it('hydrates the new default when there is no persisted profile', async () => {
    const { store, defaults } = await freshProfile();
    expect(store.getState().avatar).toBe(defaults[0]);
  });
});
