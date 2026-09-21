/**
 * GET /api/classroom/gate — the classroom page's login gate.
 *
 * The session plane and the admin preview cookie are mocked (other modules'
 * concerns, covered by auth-owner.test.ts / course-preview's own suite); this
 * suite pins the route's contract: which identities may open a classroom page
 * and what everyone else receives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateUserSession: vi.fn(),
  coursePreviewOwnerId: vi.fn(),
}));

vi.mock('@/lib/server/user-auth', () => ({
  readUserSessionToken: () => undefined,
  validateUserSession: mocks.validateUserSession,
}));
vi.mock('@/lib/admin/course-preview', () => ({
  coursePreviewOwnerId: mocks.coursePreviewOwnerId,
}));

import { GET } from '@/app/api/classroom/gate/route';

const USER_OWNER = 'user:7c9e6679-7425-40de-944b-e07fc5f903ae';
const ANON_OWNER = 'anon:a652e716-0e2e-47f5-8432-4ee60f6f0977';
const SESSION = {
  userId: USER_OWNER.slice('user:'.length),
  username: '1001',
  displayName: null,
  avatarUrl: null,
  nickname: null,
  bio: null,
  canCreateCourses: false,
  courseCreationQuota: 3,
};

function requestWithCookie(cookie?: string): Request {
  return new Request('http://localhost/api/classroom/gate', cookie ? { headers: { cookie } } : {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.coursePreviewOwnerId.mockReturnValue(null);
  mocks.validateUserSession.mockResolvedValue(null);
});

describe('GET /api/classroom/gate', () => {
  it('allows a valid product session', async () => {
    mocks.validateUserSession.mockResolvedValue(SESSION);

    const response = await GET(requestWithCookie('openmaic_session=valid'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, allowed: true });
  });

  it('allows an admin preview cookie even when it previews an anonymous author', async () => {
    mocks.coursePreviewOwnerId.mockReturnValue(ANON_OWNER);

    const response = await GET(requestWithCookie('openmaic_admin_preview=signed'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, allowed: true });
  });

  it('refuses an anonymous visitor with the contract 401', async () => {
    const response = await GET(
      requestWithCookie(`anonymous_id=${ANON_OWNER.slice('anon:'.length)}`),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'UNAUTHENTICATED',
    });
  });

  it('refuses a visitor with no cookies at all', async () => {
    const response = await GET(requestWithCookie());

    expect(response.status).toBe(401);
  });

  it('fails closed when the session check itself errors', async () => {
    mocks.validateUserSession.mockRejectedValue(new Error('db down'));

    const response = await GET(requestWithCookie('openmaic_session=maybe-valid'));

    expect(response.status).toBe(401);
  });
});
