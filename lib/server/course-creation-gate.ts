/**
 * Course-creation grant — the per-account permission switch and live-course
 * quota that gate both creation funnels (`PUT /api/persistence/documents/:id`
 * for a genuinely new stage, and `POST /api/stages`).
 *
 * Voice of the rules (managed in the admin console's user editor):
 * - `user_accounts.can_create_courses` — default FALSE; admin opens it per
 *   account. A logged-out visitor has no account row and is handled by the
 *   pre-existing login gate, not by this module.
 * - `user_accounts.course_creation_quota` — default 3. Counts the account's
 *   LIVE courses (`stage_meta` rows with `deleted_at IS NULL`), so generating
 *   and failed courses occupy quota and a user soft-delete frees it.
 */
import { getAdminPool } from '@/lib/admin/db';

export interface CourseCreationGrant {
  allowed: boolean;
  /** Why creation is blocked, when `allowed` is false. */
  reason: 'forbidden' | 'quota' | null;
  /** The account's configured quota (informational for UI copy). */
  limit: number;
  /** Live (non-tombstoned) course count. Only queried when the switch is on. */
  used: number;
}

const USER_OWNER_PREFIX = 'user:';

/** Normalize a `user:<uuid>` owner string or a bare account id. */
export function parseUserAccountId(userKey: string): string | null {
  const id = userKey.startsWith(USER_OWNER_PREFIX)
    ? userKey.slice(USER_OWNER_PREFIX.length)
    : userKey;
  return id.length > 0 ? id : null;
}

export async function getCourseCreationGrant(userKey: string): Promise<CourseCreationGrant> {
  const userId = parseUserAccountId(userKey);
  if (!userId) return { allowed: false, reason: 'forbidden', limit: 0, used: 0 };

  const pool = await getAdminPool();
  const userResult = await pool.query<{
    can_create_courses: boolean;
    course_creation_quota: number;
  }>(
    'SELECT can_create_courses, course_creation_quota FROM user_accounts WHERE id = $1',
    [userId],
  );
  const user = userResult.rows[0];
  // Unknown account (or a non-user owner string): no grant, no count query.
  if (!user) return { allowed: false, reason: 'forbidden', limit: 0, used: 0 };
  if (!user.can_create_courses) {
    // `used` stays 0 here — it only feeds copy the forbidden banner never shows.
    return { allowed: false, reason: 'forbidden', limit: user.course_creation_quota, used: 0 };
  }

  const countResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM stage_meta WHERE owner_id = $1 AND deleted_at IS NULL',
    [`${USER_OWNER_PREFIX}${userId}`],
  );
  const used = Number.parseInt(countResult.rows[0]?.count ?? '0', 10) || 0;
  if (used >= user.course_creation_quota) {
    return { allowed: false, reason: 'quota', limit: user.course_creation_quota, used };
  }
  return { allowed: true, reason: null, limit: user.course_creation_quota, used };
}
