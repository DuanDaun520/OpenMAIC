/**
 * GET /api/auth/me — who am I? 401 with `errorCode: 'UNAUTHENTICATED'` when
 * no live session, so client gates can branch on the status alone. Kept cheap
 * (single JOIN) because the site header calls it on every page.
 *
 * Also carries the course-creation grant (switch + quota + live count) so the
 * homepage composer and my-courses can gray their entry points without a
 * second round-trip. The grant's COUNT rides the owner index on stage_meta
 * (stage_meta_owner_idx), keeping it in the same cheap ballpark.
 */
import { NextResponse } from 'next/server';

import { getCourseCreationGrant } from '@/lib/server/course-creation-gate';
import { requireUser } from '@/lib/server/user-auth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { userId, username, displayName, avatarUrl, nickname, bio } = guard.session;
  const grant = await getCourseCreationGrant(userId);
  return NextResponse.json({
    success: true,
    user: {
      id: userId,
      username,
      displayName,
      avatarUrl,
      nickname,
      bio,
      courseCreation: {
        allowed: grant.allowed,
        reason: grant.reason,
        limit: grant.limit,
        used: grant.used,
      },
    },
  });
}
