/** POST /api/admin/auth/logout — destroy the session server-side and clear the cookie. */
import { NextResponse } from 'next/server';

import {
  ADMIN_SESSION_COOKIE,
  destroyAdminSession,
  readSessionToken,
  sessionCookieOptions,
} from '@/lib/admin/auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  await destroyAdminSession(readSessionToken(request));
  const response = NextResponse.json({ success: true });
  response.cookies.set(ADMIN_SESSION_COOKIE, '', { ...sessionCookieOptions(request, 0) });
  return response;
}
