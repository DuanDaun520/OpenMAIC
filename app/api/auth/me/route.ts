/**
 * GET /api/auth/me — who am I? 401 with `errorCode: 'UNAUTHENTICATED'` when
 * no live session, so client gates can branch on the status alone. Kept cheap
 * (single JOIN) because the site header calls it on every page.
 */
import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/server/user-auth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { userId, username, displayName, avatarUrl, nickname, bio } = guard.session;
  return NextResponse.json({
    success: true,
    user: { id: userId, username, displayName, avatarUrl, nickname, bio },
  });
}
