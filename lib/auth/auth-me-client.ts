'use client';

/**
 * Cached /api/auth/me reader with in-flight dedup.
 *
 * A single page load used to fetch this route three times (the layout's
 * account-profile hydration, the home page's creation-grant probe, and the
 * site header's session state) — and every `openmaic:auth-changed` re-fired
 * all three. One page load needs one request, so all callers share this
 * module-level promise.
 *
 * The cached value is the raw response facts — status, ok, parsed body — and
 * deliberately untyped beyond that: the route's response shape is still
 * evolving, so each caller narrows it with its own generic.
 *
 * Invalidation rides the same `openmaic:auth-changed` window event the app
 * already fires after every auth mutation (login/logout/password); the cache
 * is dropped rather than eagerly refetched, so the re-syncs of all listeners
 * still coalesce onto one request. Profile PATCHes do not fire that event —
 * pre-existing behavior this cache preserves.
 */
export interface AuthMeSnapshot<T = unknown> {
  status: number;
  ok: boolean;
  body: T | null;
}

let cached: Promise<AuthMeSnapshot> | null = null;

async function load(): Promise<AuthMeSnapshot> {
  try {
    const response = await fetch('/api/auth/me');
    const body = response.ok ? await response.json().catch(() => null) : null;
    return { status: response.status, ok: response.ok, body };
  } catch {
    // Network-level failure: callers treat this like their old catch branch
    // (keep current state / fall back to signed-out visuals).
    return { status: 0, ok: false, body: null };
  }
}

export function fetchAuthMe<T = unknown>(options?: {
  /** Skip the cache once (e.g. a remount after soft navigation). */
  refresh?: boolean;
}): Promise<AuthMeSnapshot<T>> {
  if (options?.refresh || !cached) cached = load();
  return cached as Promise<AuthMeSnapshot<T>>;
}

if (typeof window !== 'undefined') {
  window.addEventListener('openmaic:auth-changed', () => {
    cached = null;
  });
}
