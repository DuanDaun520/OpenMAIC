/**
 * GET /api/explore — the public face of 学习天地: every course an admin has
 * published. Read-only and unauthenticated (publication IS the visibility
 * decision); no admin session is involved — the admin pool is shared only
 * because that is where course_publications lives.
 *
 * Owner ids themselves are never returned. The author's DISPLAY name is
 * (真实姓名 > AI 昵称 > 工号 — the same resolution order as the admin course
 * list), because the shelf cards now show who made each course; anonymous
 * owners match no user_accounts row and surface as a null authorName the
 * client renders as 匿名用户. The caller's favorite state rides along too:
 * read-only owner resolution (no cookie minting on a public listing) —
 * signed-in callers get their flags, an anonymous cookie identifies the
 * browser's partition, and a first-time visitor passes null, which never
 * matches the join.
 *
 * Each row carries the card-cover chain the shelf renders: explicit AI cover
 * (course_user_meta) > first slide's canvas (slides only, for the thumbnail
 * renderer) > the client's deterministic gradient fallback. Rows also carry
 * the admin's 推荐到首页 flag (`featured`) — homepage-featured courses sort
 * first, so the homepage can pick them without a second query.
 */
import { isDatabaseConfigured, getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { readAuthAwareOwnerId } from '@/lib/server/agent-runtime/auth-owner';

export const runtime = 'nodejs';

interface ExploreCourse {
  id: string;
  name: string;
  description: string | null;
  scene_count: string;
  updated_at: string | Date;
  category_name: string | null;
  cover_url: string | null;
  featured: boolean | null;
  first_scene_data: Record<string, unknown> | null;
  owner_display_name: string | null;
  owner_nickname: string | null;
  owner_username: string | null;
  is_favorite: boolean | null;
}

export async function GET(req: Request) {
  if (!isDatabaseConfigured()) {
    return apiError('INTERNAL_ERROR', 503, '学习天地需要配置 DATABASE_URL');
  }
  const ownerId = (await readAuthAwareOwnerId(req)) ?? null;
  const pool = await getAdminPool();
  const rows = await pool.query<ExploreCourse>(
    `SELECT s.id, s.name, s.description,
            (SELECT COUNT(*) FROM document_scenes sc WHERE sc.stage_id = s.id) AS scene_count,
            to_timestamp(s.updated_at / 1000) AS updated_at,
            cat.name AS category_name,
            cov.cover_url,
            pub.featured,
            fs.scene_data AS first_scene_data,
            ua.display_name AS owner_display_name,
            ua.nickname AS owner_nickname,
            ua.username AS owner_username,
            (fav.stage_id IS NOT NULL) AS is_favorite
     FROM document_stages s
     JOIN course_publications pub ON pub.stage_id = s.id AND pub.status = 'published'
     LEFT JOIN course_category_map ccm ON ccm.stage_id = s.id
     LEFT JOIN course_categories cat ON cat.id = ccm.category_id
     LEFT JOIN course_user_meta cov ON cov.stage_id = s.id
     LEFT JOIN user_accounts ua ON s.owner_id = 'user:' || ua.id::text
     LEFT JOIN course_favorites fav ON fav.stage_id = s.id AND fav.owner_id = $1
     LEFT JOIN LATERAL (
       SELECT ds.data AS scene_data
         FROM document_scenes ds
        WHERE ds.stage_id = s.id AND ds.data ->> 'type' = 'slide'
        ORDER BY ds.scene_order ASC, ds.id ASC
        LIMIT 1
     ) fs ON TRUE
     ORDER BY pub.featured DESC, s.updated_at DESC
     LIMIT 200`,
    [ownerId],
  );
  return Response.json({
    success: true,
    courses: rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      sceneCount: Number(row.scene_count),
      updatedAt: row.updated_at,
      categoryName: row.category_name,
      featured: row.featured === true,
      // 真实姓名 first, then AI 昵称, then 工号 — anonymous authors stay null.
      authorName: row.owner_display_name ?? row.owner_nickname ?? row.owner_username ?? null,
      isFavorite: row.is_favorite === true,
      ...(row.cover_url ? { coverUrl: row.cover_url } : {}),
      ...(row.first_scene_data ? { firstScene: row.first_scene_data } : {}),
    })),
  });
}
