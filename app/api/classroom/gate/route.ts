/**
 * GET /api/classroom/gate — may THIS browser open a classroom page?
 *
 * The classroom route is login-gated on the client (the global login modal,
 * same pattern as /my-courses), but the answer must come from the server:
 * the product session cookie is HttpOnly, and the admin console's 打开课程
 * preview carries no product session at all. So the gate accepts either
 * identity:
 *
 *   - a valid product session (owner resolves to `user:<id>`), or
 *   - a valid admin course-preview cookie — any owner shape, because the
 *     console mints it fresh per click and an admin previewing an anonymous
 *     author's course (`anon:<uuid>`) must not be bounced to a login the
 *     preview deliberately outranks.
 *
 * Everyone else answers 401 and the classroom page opens the login modal.
 * This is a page-level product gate only: the underlying document reads keep
 * their existing posture (see the persistence route's access model).
 */
import { coursePreviewOwnerId } from '@/lib/admin/course-preview';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { readAuthAwareOwnerId } from '@/lib/server/agent-runtime/auth-owner';

// The answer is per-viewer session state; it must never be cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  // Preview first, mirroring resolveAuthAwareOwnerId's precedence: a preview
  // owner can be `anon:<uuid>`, which the `user:` prefix test below would
  // wrongly reject.
  if (coursePreviewOwnerId(request)) {
    return apiSuccess({ allowed: true });
  }
  const ownerId = await readAuthAwareOwnerId(request);
  if (ownerId?.startsWith('user:')) {
    return apiSuccess({ allowed: true });
  }
  return apiError(API_ERROR_CODES.UNAUTHENTICATED, 401, '未登录');
}
