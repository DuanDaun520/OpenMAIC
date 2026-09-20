/**
 * POST /api/auth/password — change the logged-in user's password. Verifies the
 * current password, rotates the hash, and reissues exactly one session (all
 * other sessions die), returning a fresh cookie so the caller stays logged in.
 */
import { NextResponse } from 'next/server';

import { apiError } from '@/lib/server/api-response';
import { changeUserPassword, requireUser, withUserSessionCookie } from '@/lib/server/user-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const guard = await requireUser(request, { mutation: true });
  if (!guard.ok) return guard.response;

  let body: { oldPassword?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!oldPassword || !newPassword) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '请输入当前密码和新密码');
  }

  const result = await changeUserPassword({
    userId: guard.session.userId,
    oldPassword,
    newPassword,
  });
  if (!result.ok) {
    return apiError('INVALID_CREDENTIALS', 400, result.error);
  }
  return withUserSessionCookie(NextResponse.json({ success: true }), request, result.token);
}
