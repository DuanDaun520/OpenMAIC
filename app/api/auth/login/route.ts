/**
 * POST /api/auth/login — exchange product-user credentials for a session
 * cookie (`openmaic_user_session`). Reachable unauthenticated (it is the
 * gate); account creation happens in the admin console, not here.
 */
import { NextResponse } from 'next/server';

import { requestIp } from '@/lib/admin/audit';
import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { mintAnonymousCookieHeader, readAnonymousOwnerId } from '@/lib/server/agent-runtime/owner';
import { claimAnonymousPartition } from '@/lib/server/owner-claim';
import { apiError } from '@/lib/server/api-response';
import {
  USER_SESSION_COOKIE,
  authenticateUser,
  createUserSession,
  userSessionCookieOptions,
} from '@/lib/server/user-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return apiError('INTERNAL_ERROR', 503, '登录功能需要配置 DATABASE_URL（当前为纯浏览器模式）');
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '请输入用户名和密码');
  }

  const ip = requestIp(request);
  const auth = await authenticateUser({
    username,
    password,
    clientKey: `${ip ?? 'unknown'}:${username}`,
  });
  if (!auth.ok) {
    return apiError('INVALID_CREDENTIALS', 401, auth.error);
  }

  const { token, expiresAt } = await createUserSession({
    userId: auth.userId,
    ip,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  // Claim the browser's current anonymous partition (courses, favorites,
  // sessions…) for this account, then rotate the anonymous cookie so no
  // stale partition survives the login. A failed claim keeps the old cookie:
  // the next login retries it, and nothing is half-lost.
  const anonOwnerId = readAnonymousOwnerId(request);
  let anonymousPartitionClaimed = true;
  if (anonOwnerId) {
    try {
      const pool = await getAdminPool();
      await claimAnonymousPartition({
        pool,
        anonOwnerId,
        userOwnerId: `user:${auth.userId}`,
      });
    } catch (error) {
      console.error('[auth] anonymous partition claim failed; anon cookie kept for retry', error);
      anonymousPartitionClaimed = false;
    }
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(USER_SESSION_COOKIE, token, {
    ...userSessionCookieOptions(request, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
  if (anonymousPartitionClaimed) {
    response.headers.append('Set-Cookie', mintAnonymousCookieHeader());
  }
  return response;
}
