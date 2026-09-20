/**
 * GET /api/explore — the author + favorite decorations on the 学习天地 shelf.
 *
 * The pool and the owner resolution are mocked: this suite pins the route's
 * own contract (which identity columns it joins, what it binds for an
 * unidentified visitor, and how rows map onto the response), not Postgres or
 * session behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configured: true,
  query: vi.fn(),
  readAuthAwareOwnerId: vi.fn(),
}));

vi.mock('@/lib/admin/db', () => ({
  isDatabaseConfigured: () => mocks.configured,
  getAdminPool: async () => ({ query: mocks.query }),
}));
vi.mock('@/lib/server/agent-runtime/auth-owner', () => ({
  readAuthAwareOwnerId: mocks.readAuthAwareOwnerId,
}));

import { GET } from '@/app/api/explore/route';

const USER_OWNER = 'user:7c9e6679-7425-40de-944b-e07fc5f903ae';

/** A row as pg returns it (snake_case columns, counts as text). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'stage_demo',
    name: '演示课程',
    description: '课程简介',
    scene_count: '5',
    updated_at: new Date('2026-09-01T00:00:00Z'),
    category_name: '培训',
    cover_url: null,
    featured: false,
    first_scene_data: null,
    owner_display_name: '张三',
    owner_nickname: '小明',
    owner_username: '1001',
    is_favorite: false,
    ...overrides,
  };
}

const call = () => GET(new Request('http://localhost/api/explore'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured = true;
  mocks.readAuthAwareOwnerId.mockResolvedValue(USER_OWNER);
  mocks.query.mockResolvedValue({ rows: [row()] });
});

describe('GET /api/explore', () => {
  it('keeps answering 503 with the contract error when no database is configured', async () => {
    mocks.configured = false;

    const response = await call();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
    });
    // The guard runs before any identity resolution or query.
    expect(mocks.readAuthAwareOwnerId).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('joins the author identity and the caller’s favorites under the resolved owner', async () => {
    await call();

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    // The admin course list's join idiom — anonymous owners simply miss it.
    expect(sql).toContain("LEFT JOIN user_accounts ua ON s.owner_id = 'user:' || ua.id::text");
    expect(sql).toContain(
      'LEFT JOIN course_favorites fav ON fav.stage_id = s.id AND fav.owner_id = $1',
    );
    expect(params).toEqual([USER_OWNER]);
  });

  it('binds null for an unidentified visitor so the favorite join never matches', async () => {
    mocks.readAuthAwareOwnerId.mockResolvedValue(undefined);

    await call();

    expect(mocks.query.mock.calls[0][1]).toEqual([null]);
  });

  it('resolves the author as 真实姓名 > AI 昵称 > 工号; anonymous stays null', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        row(),
        row({ id: 'b', owner_display_name: null }),
        row({ id: 'c', owner_display_name: null, owner_nickname: null }),
        row({
          id: 'd',
          owner_display_name: null,
          owner_nickname: null,
          owner_username: null,
        }),
      ],
    });

    const body = (await (await call()).json()) as { courses: Array<{ authorName: string | null }> };

    expect(body.courses.map((course) => course.authorName)).toEqual(['张三', '小明', '1001', null]);
  });

  it('maps the favorite flag and never leaks the owner id', async () => {
    mocks.query.mockResolvedValue({
      rows: [row({ is_favorite: true }), row({ id: 'b', is_favorite: false })],
    });

    const response = await call();
    const body = (await response.json()) as unknown;

    expect((body as { courses: Array<{ isFavorite: boolean }> }).courses.map((c) => c.isFavorite)).toEqual([
      true,
      false,
    ]);
    // The shelf exposes the author's display name only — never the owner id.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(USER_OWNER);
    expect(serialized).not.toContain('owner_');
  });
});
