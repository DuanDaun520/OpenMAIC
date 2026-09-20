/**
 * User Profile Store
 *
 * Persists avatar, nickname & bio through the `@openmaic/storage` KVStore in
 * the `account` scope: this is the learner's own identity, exactly the data a
 * server-backed deployment is expected to carry across their devices.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createKVPersistStorage, purgeLegacyPersistKey } from '@/lib/store/kv-persist';

/**
 * Bound after the store exists; see `onWriteRefused` for why it is not inlined.
 * The explicit annotation is what breaks the type cycle — inferring this from
 * the store would put the store back in its own definition.
 */
const recovery: { rehydrate?: () => void | Promise<void> } = {};

/** Predefined avatar options — flat-vector learner portraits in the same
 * style as the AI roster (see public/avatars). */
export const AVATAR_OPTIONS = [
  '/avatars/user-3.png',
  '/avatars/user-3-b.png',
  '/avatars/user-3-c.png',
  '/avatars/user-3-d.png',
  '/avatars/teacher-3.png',
  '/avatars/teacher-3-f.png',
] as const;

export interface UserProfileState {
  /** Local avatar path or data-URL (for custom uploads) */
  avatar: string;
  nickname: string;
  bio: string;
  /**
   * True once a live account session was observed: the server-side account
   * (`user_accounts`) is then the source of truth — edits are pushed up via
   * PATCH /api/auth/profile and `hydrateFromServer` wins over KV-restored
   * values. Anonymous / pure-browser mode keeps the KV behaviour unchanged.
   * Deliberately NOT persisted: it is re-established on every load by
   * `components/account-profile-sync.tsx`.
   */
  accountBound: boolean;
  /**
   * The logged-in account's header-style name (真实姓名 > 工号) — the fallback
   * profile surfaces show while no AI 昵称 is set, so they read as "the
   * logged-in user" instead of the generic 同学. Session state exactly like
   * `accountBound`: filled by `hydrateFromServer`, never persisted, null
   * while anonymous.
   */
  accountName: string | null;
  setAvatar: (avatar: string) => void;
  setNickname: (nickname: string) => void;
  setBio: (bio: string) => void;
  /** Bind to a live session, keeping this browser's local values but adopting
   * the account's 真实姓名/工号 as the display fallback. */
  bindToAccount: (accountName: string | null) => void;
  markAnonymous: () => void;
  /** Adopt the server's values wholesale (server-wins hydration). */
  hydrateFromServer: (profile: ServerProfile) => void;
}

/** The account-side shape returned by /api/auth/me and PATCH /api/auth/profile. */
export interface ServerProfile {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  nickname: string | null;
  bio: string | null;
}

/** Fire-and-forget push of profile fields to the account. Failures are
 * swallowed: the next hydration reconciles, and a hard failure would turn a
 * cosmetic profile edit into a blocking error. */
export function pushServerProfilePatch(
  patch: Partial<{ avatarUrl: string; nickname: string; bio: string }>,
): void {
  void fetch('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-request': '1' },
    body: JSON.stringify(patch),
  }).catch(() => undefined);
}

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set, get) => ({
      avatar: AVATAR_OPTIONS[0],
      nickname: '',
      bio: '',
      accountBound: false,
      accountName: null,
      setAvatar: (avatar) => {
        set({ avatar });
        if (get().accountBound) pushServerProfilePatch({ avatarUrl: avatar });
      },
      setNickname: (nickname) => {
        set({ nickname });
        if (get().accountBound) pushServerProfilePatch({ nickname });
      },
      setBio: (bio) => {
        set({ bio });
        if (get().accountBound) pushServerProfilePatch({ bio });
      },
      bindToAccount: (accountName) => set({ accountBound: true, accountName }),
      markAnonymous: () => set({ accountBound: false, accountName: null }),
      hydrateFromServer: (profile) =>
        set({
          avatar: profile.avatarUrl || AVATAR_OPTIONS[0],
          nickname: profile.nickname ?? '',
          bio: profile.bio ?? '',
          accountBound: true,
          accountName: profile.displayName?.trim() || profile.username || null,
        }),
    }),
    {
      name: 'user-profile-storage',
      version: 1,
      // `accountBound` is session state, not user data: it is re-derived from
      // /api/auth/me on every load by the account-profile-sync component, and
      // persisting it would resurrect a stale "logged in" across a logout.
      partialize: (state) => ({
        avatar: state.avatar,
        nickname: state.nickname,
        bio: state.bio,
      }),
      // v1: the default learner portrait moved to the flat-vector roster
      // style. Remap only the old DEFAULT — an explicitly picked avatar keeps
      // its file (the old files still ship).
      migrate: (persistedState: unknown) => {
        const state = persistedState as UserProfileState | undefined;
        if (!state || state.avatar !== '/avatars/user.png') {
          return (persistedState ?? {}) as UserProfileState;
        }
        return { ...state, avatar: AVATAR_OPTIONS[0] };
      },
      // Typed to the partialized shape: zustand pairs `storage` with what
      // `partialize` emits, not with the full store state.
      storage: createKVPersistStorage<{ avatar: string; nickname: string; bio: string }>(
        'account',
        {
          // One recovery attempt when a write is refused because hydration never
          // succeeded — the backend may have come back since. Routed through a
          // variable assigned below rather than naming the store directly: a
          // self-reference here would make the store's own type circular and
          // silently widen every selector to `any`.
          onWriteRefused: () => recovery.rehydrate?.(),
        },
      ),
    },
  ),
);

// Bound after the store exists so the `onWriteRefused` hook above stays free of
// a self-reference (see the comment there).
recovery.rehydrate = () => useUserProfileStore.persist.rehydrate();

// Best-effort, fire-and-forget: drop the pre-cutover raw `localStorage` blob.
// It is never read (this store does not migrate legacy data), so a leftover is
// only garbage. No correctness depends on it.
purgeLegacyPersistKey('user-profile-storage');
