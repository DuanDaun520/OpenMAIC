'use client';

/**
 * Global account↔profile sync — mounted once in the root layout.
 *
 * Establishes who owns the learner profile values:
 *
 *  - logged in → the server account (`user_accounts`) is authoritative: the
 *    store is hydrated from /api/auth/me on load and on every
 *    `openmaic:auth-changed`, and edits are pushed up by the store's setters
 *    (the account's 真实姓名/工号 rides along as `accountName`, the fallback
 *    profile surfaces show while no AI 昵称 is set);
 *  - anonymous / pure-browser mode → the local KV-persisted values stand
 *    exactly as before accounts existed;
 *  - first contact with an account that has no personalization yet → this
 *    browser's local values are pushed up once (one-time migration), then the
 *    server is authoritative.
 *
 * The component renders nothing; it only reconciles state.
 */
import { useEffect } from 'react';

import { fetchAuthMe } from '@/lib/auth/auth-me-client';
import {
  AVATAR_OPTIONS,
  pushServerProfilePatch,
  useUserProfileStore,
  type ServerProfile,
} from '@/lib/store/user-profile';

export function AccountProfileSync(): null {
  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      let me: { user?: ServerProfile } | null = null;
      // Shared cache: the home page and site header read the same response
      // (invalidated by openmaic:auth-changed, which also re-runs this sync).
      const snapshot = await fetchAuthMe<{ user?: ServerProfile }>();
      if (!snapshot.ok) {
        // 401 (no session) or network failure: local values stay
        // authoritative; the next auth-changed (or a later page load)
        // re-runs the reconciliation.
        if (!cancelled && snapshot.status !== 0) useUserProfileStore.getState().markAnonymous();
        return;
      }
      me = snapshot.body;
      if (cancelled || !me?.user) return;

      const store = useUserProfileStore.getState();
      const { avatarUrl, nickname, bio } = me.user;
      const serverPersonalized =
        !!nickname || !!bio || (!!avatarUrl && avatarUrl !== AVATAR_OPTIONS[0]);

      if (store.accountBound || serverPersonalized) {
        store.hydrateFromServer(me.user); // server wins
        return;
      }
      // Unpersonalized account: adopt this browser's local profile once so a
      // pre-account user keeps their avatar/nickname after their first login.
      store.bindToAccount(me.user.displayName?.trim() || me.user.username || null);
      pushServerProfilePatch({
        avatarUrl: store.avatar,
        nickname: store.nickname,
        bio: store.bio,
      });
    };

    void sync();
    const onAuthChanged = () => void sync();
    window.addEventListener('openmaic:auth-changed', onAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('openmaic:auth-changed', onAuthChanged);
    };
  }, []);

  return null;
}
