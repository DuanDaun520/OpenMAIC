/**
 * POST /api/admin/auth/login — exchange credentials for a session cookie.
 *
 * Unlike every other admin route this endpoint is reachable unauthenticated
 * (it is the gate). Database absence answers 503 with an actionable message:
 * the console requires DB mode and there is no browser-local fallback.
 */
import { NextResponse } from 'next/server';

import { recordAudit, requestIp } from '@/lib/admin/audit';
import {
  ADMIN_SESSION_COOKIE,
  authenticateAdmin,
  createAdminSession,
  sessionCookieOptions,
} from '@/lib/admin/auth';
import { isDatabaseConfigured } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return apiError('INTERNAL_ERROR', 503, '管理后台需要配置 DATABASE_URL（当前为纯浏览器模式）');
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
  const clientKey = `${ip ?? 'unknown'}:${username}`;
  const auth = await authenticateAdmin({ username, password, clientKey });
  if (!auth.ok) {
    return apiError('INVALID_CREDENTIALS', 401, auth.error);
  }

  const { token, expiresAt } = await createAdminSession({
    userId: auth.userId,
    ip,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  const response = NextResponse.json({
    success: true,
    admin: { username: auth.username, role: auth.role },
  });
  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    ...sessionCookieOptions(request, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
  await recordAudit(
    { userId: auth.userId, username: auth.username, role: auth.role },
    { action: 'auth.login', ip },
  );
  return response;
}
