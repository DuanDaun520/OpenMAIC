/**
 * PATCH /api/auth/profile — validation of the presentation-identity fields
 * (avatar / AI 昵称 / bio) and the shape of the persisted update.
 *
 * requireUser and the admin pool are mocked: this suite pins the route's own
 * contract (what it accepts, what SQL it issues), not session or DB behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/server/user-auth', () => ({
  requireUser: mocks.requireUser,
  DEFAULT_AVATAR_URL: '/avatars/user-3.png',
}));
vi.mock('@/lib/admin/db', () => ({
  getAdminPool: async () => ({ query: mocks.query }),
}));

import { PATCH } from '@/app/api/auth/profile/route';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc5f903ae';
const SESSION = {
  userId: USER_ID,
  username: '1001',
  displayName: '张三',
  avatarUrl: null,
  nickname: null,
  bio: null,
};

function call(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-request': '1' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ ok: true, session: SESSION });
  mocks.query.mockResolvedValue({
    rows: [
      {
        id: USER_ID,
        username: '1001',
        display_name: '张三',
        avatar_url: null,
        nickname: null,
        bio: null,
      },
    ],
  });
});

describe('PATCH /api/auth/profile', () => {
  it('passes the guard response through when unauthenticated', async () => {
    const unauthorized = Response.json({ success: false }, { status: 401 });
    mocks.requireUser.mockResolvedValue({ ok: false, response: unauthorized });

    const response = await call({ nickname: 'x' });

    expect(response).toBe(unauthorized);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('accepts a preset avatar path and issues a partial update', async () => {
    const response = await call({ avatarUrl: '/avatars/user-1.png' });

    expect(response.status).toBe(200);
    const sql = mocks.query.mock.calls[0][0] as string;
    expect(sql).toContain('avatar_url = $1');
    expect(sql).not.toContain('nickname =');
    expect(mocks.query.mock.calls[0][1]).toEqual(['/avatars/user-1.png', USER_ID]);
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain(`WHERE id = $2`);
  });

  it('maps a null avatar back to the default preset', async () => {
    await call({ avatarUrl: null });

    expect(mocks.query.mock.calls[0][1][0]).toBe('/avatars/user-3.png');
  });

  it('accepts a compact image data URL', async () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    await call({ avatarUrl: dataUrl });

    expect(mocks.query.mock.calls[0][1][0]).toBe(dataUrl);
  });

  it('refuses an avatar URL that is neither preset nor data URL', async () => {
    for (const bad of ['https://evil.example/a.png', '/avatars/../etc/passwd', 'javascript:1']) {
      const response = await call({ avatarUrl: bad });
      expect(response.status).toBe(400);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses an oversized avatar data URL', async () => {
    const response = await call({ avatarUrl: `data:image/png;base64,${'A'.repeat(280_001)}` });

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('trims the nickname and persists an empty one as null', async () => {
    await call({ nickname: '  小明  ' });
    expect(mocks.query.mock.calls[0][1][0]).toBe('小明');

    await call({ nickname: '   ' });
    expect(mocks.query.mock.calls[1][1][0]).toBeNull();
  });

  it('refuses over-length nickname and bio, and non-string values', async () => {
    expect((await call({ nickname: '超'.repeat(21) })).status).toBe(400);
    expect((await call({ bio: '长'.repeat(201) })).status).toBe(400);
    expect((await call({ nickname: 42 })).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses an empty patch body', async () => {
    const response = await call({});

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('mirrors /api/auth/me in the response, defaulting a null avatar', async () => {
    const response = await call({ nickname: '小明' });
    const body = (await response.json()) as {
      success: boolean;
      user: Record<string, unknown>;
    };

    expect(body.success).toBe(true);
    expect(body.user).toEqual({
      id: USER_ID,
      username: '1001',
      displayName: '张三',
      avatarUrl: '/avatars/user-3.png',
      nickname: null,
      bio: null,
    });
  });
});
