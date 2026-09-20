/**
 * auth-owner — the composition layer binding the product session to the
 * agent-runtime owner identity.
 *
 * The session plane and the admin preview cookie are mocked (they are other
 * modules' concerns); the anonymous fallback underneath is the REAL owner.ts
 * cookie logic, so mint/reuse behavior is exercised end to end.
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

import { readAuthAwareOwnerId, resolveAuthAwareOwnerId } from '@/lib/server/agent-runtime/auth-owner';

const ANON_UUID = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
const USER_ID = '7c9e6679-7425-40de-944b-e07fc5f903ae';
const SESSION = {
  userId: USER_ID,
  username: '1001',
  displayName: null,
  avatarUrl: null,
  nickname: null,
  bio: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.coursePreviewOwnerId.mockReturnValue(undefined);
});

function requestWithCookie(cookie?: string): Request {
  return new Request('http://localhost/anything', cookie ? { headers: { cookie } } : {});
}

describe('resolveAuthAwareOwnerId', () => {
  it('runs a valid session under user:<id> and mints no anonymous cookie', async () => {
    mocks.validateUserSession.mockResolvedValue(SESSION);
    const responseHeaders = new Headers();

    const resolved = await resolveAuthAwareOwnerId(
      requestWithCookie(`anonymous_id=${ANON_UUID}`),
      responseHeaders,
    );

    expect(resolved.ownerId).toBe(`user:${USER_ID}`);
    expect(resolved.session).toBe(SESSION);
    expect(responseHeaders.get('set-cookie')).toBeNull();
  });

  it('falls back to the existing anonymous cookie when there is no session', async () => {
    mocks.validateUserSession.mockResolvedValue(null);
    const responseHeaders = new Headers();

    const resolved = await resolveAuthAwareOwnerId(
      requestWithCookie(`anonymous_id=${ANON_UUID}`),
      responseHeaders,
    );

    expect(resolved.ownerId).toBe(`anon:${ANON_UUID}`);
    expect(resolved.session).toBeNull();
    expect(responseHeaders.get('set-cookie')).toBeNull();
  });

  it('mints a fresh anonymous identity when neither session nor cookie exists', async () => {
    mocks.validateUserSession.mockResolvedValue(null);
    const responseHeaders = new Headers();

    const resolved = await resolveAuthAwareOwnerId(requestWithCookie(), responseHeaders);

    expect(resolved.ownerId).toMatch(/^anon:[0-9a-f-]{36}$/);
    expect(responseHeaders.get('set-cookie')).toContain('anonymous_id=');
  });

  it('degrades to the anonymous identity when the session check rejects', async () => {
    mocks.validateUserSession.mockRejectedValue(new Error('db down'));
    const responseHeaders = new Headers();

    const resolved = await resolveAuthAwareOwnerId(
      requestWithCookie(`anonymous_id=${ANON_UUID}`),
      responseHeaders,
    );

    expect(resolved.ownerId).toBe(`anon:${ANON_UUID}`);
    expect(resolved.session).toBeNull();
  });

  it('degrades to the anonymous identity when the session check throws synchronously', async () => {
    mocks.validateUserSession.mockImplementation(() => {
      throw new TypeError('not a function');
    });
    const responseHeaders = new Headers();

    const resolved = await resolveAuthAwareOwnerId(
      requestWithCookie(`anonymous_id=${ANON_UUID}`),
      responseHeaders,
    );

    expect(resolved.ownerId).toBe(`anon:${ANON_UUID}`);
  });

  it('lets a freshly minted admin preview cookie outrank the session', async () => {
    mocks.coursePreviewOwnerId.mockReturnValue('user:previewed-course-owner');
    mocks.validateUserSession.mockResolvedValue(SESSION);

    const resolved = await resolveAuthAwareOwnerId(requestWithCookie(), new Headers());

    expect(resolved.ownerId).toBe('user:previewed-course-owner');
    expect(resolved.session).toBeNull();
  });
});

describe('readAuthAwareOwnerId', () => {
  it('returns user:<id> for a valid session without minting anything', async () => {
    mocks.validateUserSession.mockResolvedValue(SESSION);

    await expect(readAuthAwareOwnerId(requestWithCookie())).resolves.toBe(`user:${USER_ID}`);
  });

  it('returns the existing anonymous owner when unauthenticated', async () => {
    mocks.validateUserSession.mockResolvedValue(null);

    await expect(
      readAuthAwareOwnerId(requestWithCookie(`anonymous_id=${ANON_UUID}`)),
    ).resolves.toBe(`anon:${ANON_UUID}`);
  });

  it('returns undefined when unauthenticated with no cookie (never mints)', async () => {
    mocks.validateUserSession.mockResolvedValue(null);

    await expect(readAuthAwareOwnerId(requestWithCookie())).resolves.toBeUndefined();
  });
});
