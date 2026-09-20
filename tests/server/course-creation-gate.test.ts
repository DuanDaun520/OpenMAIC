/**
 * getCourseCreationGrant — the per-account course-creation switch + quota
 * matrix the two creation funnels and /api/auth/me all read.
 *
 * The admin pool is mocked: this suite pins the gate's decision table and the
 * SQL it issues (owner scoping, tombstone exclusion), not DB behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@/lib/admin/db', () => ({
  getAdminPool: async () => ({ query: mocks.query }),
}));

import { getCourseCreationGrant, parseUserAccountId } from '@/lib/server/course-creation-gate';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc5f903ae';

function mockUserRow(row: { can_create_courses: boolean; course_creation_quota: number } | null) {
  mocks.query.mockResolvedValueOnce({ rows: row ? [row] : [] });
}

function mockCount(count: string) {
  mocks.query.mockResolvedValueOnce({ rows: [{ count }] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseUserAccountId', () => {
  it('accepts both the owner string and a bare account id', () => {
    expect(parseUserAccountId(`user:${USER_ID}`)).toBe(USER_ID);
    expect(parseUserAccountId(USER_ID)).toBe(USER_ID);
  });

  it('rejects an empty remainder', () => {
    expect(parseUserAccountId('user:')).toBeNull();
    expect(parseUserAccountId('')).toBeNull();
  });
});

describe('getCourseCreationGrant', () => {
  it('forbids an empty owner key without touching the database', async () => {
    const grant = await getCourseCreationGrant('user:');

    expect(grant).toEqual({ allowed: false, reason: 'forbidden', limit: 0, used: 0 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('forbids an unknown account without issuing the count query', async () => {
    mockUserRow(null);

    const grant = await getCourseCreationGrant(`user:${USER_ID}`);

    expect(grant).toEqual({ allowed: false, reason: 'forbidden', limit: 0, used: 0 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('forbids when the admin switch is off, keeping the configured limit', async () => {
    mockUserRow({ can_create_courses: false, course_creation_quota: 5 });

    const grant = await getCourseCreationGrant(`user:${USER_ID}`);

    expect(grant).toEqual({ allowed: false, reason: 'forbidden', limit: 5, used: 0 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('allows below the quota and counts live courses under the user: owner key', async () => {
    mockUserRow({ can_create_courses: true, course_creation_quota: 3 });
    mockCount('2');

    const grant = await getCourseCreationGrant(USER_ID);

    expect(grant).toEqual({ allowed: true, reason: null, limit: 3, used: 2 });
    const [sql, params] = mocks.query.mock.calls[1];
    expect(sql).toContain('FROM stage_meta');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual([`user:${USER_ID}`]);
  });

  it('reports quota at the limit', async () => {
    mockUserRow({ can_create_courses: true, course_creation_quota: 1 });
    mockCount('1');

    const grant = await getCourseCreationGrant(`user:${USER_ID}`);

    expect(grant).toEqual({ allowed: false, reason: 'quota', limit: 1, used: 1 });
  });

  it('still allows when the count row is missing (treats as zero live courses)', async () => {
    mockUserRow({ can_create_courses: true, course_creation_quota: 3 });
    mockCount('');

    const grant = await getCourseCreationGrant(`user:${USER_ID}`);

    expect(grant).toEqual({ allowed: true, reason: null, limit: 3, used: 0 });
  });

  it('blocks creation when the quota is zero even with the switch on', async () => {
    mockUserRow({ can_create_courses: true, course_creation_quota: 0 });
    mockCount('0');

    const grant = await getCourseCreationGrant(`user:${USER_ID}`);

    expect(grant).toEqual({ allowed: false, reason: 'quota', limit: 0, used: 0 });
  });
});
