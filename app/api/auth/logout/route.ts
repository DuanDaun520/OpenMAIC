/**
 * POST /api/auth/logout — delete the server-side session row and clear the
 * cookie. The `x-user-request: 1` marker (enforced here, not via requireUser,
 * so an expired session can still log out cleanly) keeps cross-site form
 * posts from silently logging the victim out.
 */
import { mintAnonymousCookieHeader } from '@/lib/server/agent-runtime/owner';
import { apiError } from '@/lib/server/api-response';
import {
  USER_REQUEST_HEADER,
  destroyUserSession,
  readUserSessionToken,
  withUserSessionCookie,
} from '@/lib/server/user-auth';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (request.headers.get(USER_REQUEST_HEADER) !== '1') {
    return apiError('UNAUTHENTICATED', 403, '缺少请求头');
  }
  const token = readUserSessionToken(request);
  await destroyUserSession(token).catch(() => undefined);
  const response = withUserSessionCookie(NextResponse.json({ success: true }), request, null);
  // Rotate the anonymous identity too: post-logout browsing must not build on
  // whatever anonymous partition this browser had before the login — the next
  // login on this browser starts from a clean slate (and claims only what was
  // actually created anonymously since).
  response.headers.append('Set-Cookie', mintAnonymousCookieHeader());
  return response;
}
