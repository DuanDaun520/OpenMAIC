/**
 * Auth-aware owner resolution — the composition layer that binds the product
 * session plane (lib/server/user-auth.ts) to the agent-runtime owner identity
 * (./owner.ts).
 *
 * Kept out of ./owner.ts deliberately: that module stays the pure anonymous
 * identity primitive — the route tests mock it with exactly
 * `resolveRequestOwnerId` — while this layer composes it with the session
 * check. A valid product session wins and maps to `user:<user_accounts.id>`;
 * everything else falls back to the anonymous cookie identity.
 *
 * One override sits above both: a valid admin course-preview cookie
 * (lib/admin/course-preview.ts), minted by the admin console's 打开课程, runs
 * the request as the previewed course's owner so the admin can edit it on the
 * product surface. Explicit, freshly-minted intent outranks whatever session
 * plane the same browser happens to carry.
 */
import { readRequestOwnerId, resolveRequestOwnerId } from './owner';
import { coursePreviewOwnerId } from '@/lib/admin/course-preview';
import {
  readUserSessionToken,
  validateUserSession,
  type UserSession,
} from '@/lib/server/user-auth';

export interface ResolvedOwner {
  ownerId: string;
  /** The product session when the request is authenticated; null otherwise. */
  session: UserSession | null;
}

/** Validate the request's product session; null when absent or invalid, and
 * null when the check itself fails (DB down, module edge) — the request then
 * degrades to the anonymous identity rather than failing outright. */
async function readRequestSession(req: Pick<Request, 'headers'>): Promise<UserSession | null> {
  try {
    return await validateUserSession(readUserSessionToken(req));
  } catch {
    return null;
  }
}

/**
 * Auth-aware owner resolution: a valid product session runs the request under
 * `user:<user_accounts.id>` and mints no anonymous cookie; everyone else keeps
 * the anonymous cookie identity (including its Set-Cookie mint on
 * `responseHeaders`, which the caller must return to the client). An admin
 * preview cookie wins over both (see the module header).
 */
export async function resolveAuthAwareOwnerId(
  req: Pick<Request, 'headers'>,
  responseHeaders: Headers,
): Promise<ResolvedOwner> {
  const preview = coursePreviewOwnerId(req);
  if (preview) return { ownerId: preview, session: null };
  const session = await readRequestSession(req);
  if (session) return { ownerId: `user:${session.userId}`, session };
  return { ownerId: resolveRequestOwnerId(req, responseHeaders), session: null };
}

/**
 * Read-only auth-aware variant (no minting, no Set-Cookie) for attribution
 * and quota keying: `user:<id>` when authenticated, else the existing
 * anonymous owner string, else undefined.
 */
export async function readAuthAwareOwnerId(
  req: Pick<Request, 'headers'>,
): Promise<string | undefined> {
  const preview = coursePreviewOwnerId(req);
  if (preview) return preview;
  const session = await readRequestSession(req);
  return session ? `user:${session.userId}` : readRequestOwnerId(req);
}
