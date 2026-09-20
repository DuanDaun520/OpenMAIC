/**
 * /api/my-courses — the My Courses page's aggregate read + side-table writes.
 *
 * GET returns every course the caller has a relationship with — owned
 * (self-made), favorited, or previously learned — in one owner-scoped query,
 * with the card-facing projections the page needs: scene count, first-scene
 * cover data, per-course cover override, and the favorite/learn flags that
 * split the client's three tabs. The client never receives a course it has no
 * relationship to.
 *
 * POST applies one of three owner-scoped actions:
 * - { action: 'favorite', stageId, favorite }  → 收藏 toggle (course_favorites)
 * - { action: 'learned',  stageId }            → 已学习 touch  (course_learning)
 * - { action: 'cover',    stageId, coverUrl }  → set cover      (course_user_meta,
 *   owner-only: the cover is per-course and shared by every viewer, so only
 *   the course's owner may change it)
 *
 * Identity follows the product's owner model (`withRequestOwnerId`) exactly
 * like /api/stages; the page adds the account gate in front.
 */
import type { NextRequest } from 'next/server';

import { coursePreviewOwnerId } from '@/lib/admin/course-preview';
import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { resolveStageAccess } from '@/lib/server/stage-access';
import {
  courseGenerationStatus,
  type CourseGenerationFacts,
} from '@/lib/server/course-generation-status';
import { ownerApiError, ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

interface MyCourseRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  is_owned: boolean;
  meta_generation_complete: boolean | null;
  outline_generation_complete: string | null;
  meta_generation_heartbeat_at: number | null;
  meta_generation_error: string | null;
  scene_count: number;
  first_scene_type: string | null;
  first_scene_data: Record<string, unknown> | null;
  cover_url: string | null;
  is_favorite: boolean;
  last_learned_at: Date | null;
  learn_count: number | null;
}

const LIST_SQL = `
  SELECT d.id,
         d.name,
         d.description,
         d.created_at,
         d.updated_at,
         (d.owner_id = $1)                    AS is_owned,
         m.generation_complete                AS meta_generation_complete,
         o.data ->> 'generationComplete'      AS outline_generation_complete,
         m.generation_heartbeat_at            AS meta_generation_heartbeat_at,
         m.generation_error                   AS meta_generation_error,
         sc.scene_count,
         fs.scene_type                        AS first_scene_type,
         fs.scene_data                        AS first_scene_data,
         cov.cover_url,
         (fav.stage_id IS NOT NULL)           AS is_favorite,
         learn.last_learned_at,
         learn.learn_count
    FROM document_stages d
    LEFT JOIN stage_meta m ON m.stage_id = d.id
    LEFT JOIN document_outlines o ON o.stage_id = d.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS scene_count
        FROM document_scenes ds
       WHERE ds.stage_id = d.id
    ) sc ON TRUE
    LEFT JOIN LATERAL (
      SELECT ds.data ->> 'type' AS scene_type,
             ds.data            AS scene_data
        FROM document_scenes ds
       WHERE ds.stage_id = d.id
       ORDER BY ds.scene_order ASC, ds.id ASC
       LIMIT 1
    ) fs ON TRUE
    LEFT JOIN course_user_meta cov ON cov.stage_id = d.id
    LEFT JOIN course_favorites fav ON fav.stage_id = d.id AND fav.owner_id = $1
    LEFT JOIN course_learning learn ON learn.stage_id = d.id AND learn.owner_id = $1
   WHERE (d.owner_id = $1 OR fav.stage_id IS NOT NULL OR learn.stage_id IS NOT NULL)
     AND COALESCE(m.deleted_at IS NULL, TRUE)
   ORDER BY d.updated_at DESC
   LIMIT 200
`;

/** Map the SQL truth onto the card-facing generation status badge. */
function generationStatus(row: MyCourseRow, now: number) {
  return courseGenerationStatus(
    {
      generationComplete: row.meta_generation_complete,
      outlineGenerationComplete: row.outline_generation_complete,
      generationHeartbeatAt: row.meta_generation_heartbeat_at,
      updatedAtMs: row.updated_at,
    } satisfies CourseGenerationFacts,
    now,
  );
}

// GET /api/my-courses — owned ∪ favorited ∪ learned, newest first.
export async function GET(req: NextRequest) {
  if (!isDatabaseConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const pool = await getAdminPool();
    const result = await pool.query<MyCourseRow>(LIST_SQL, [ownerId]);
    const now = Date.now();
    const courses = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isOwned: row.is_owned,
      isFavorite: row.is_favorite,
      status: generationStatus(row, now),
      sceneCount: row.scene_count,
      coverUrl: row.cover_url,
      ...(row.last_learned_at
        ? {
            lastLearnedAt: new Date(row.last_learned_at).toISOString(),
            learnCount: row.learn_count ?? 1,
          }
        : {}),
      ...(row.first_scene_type === 'slide' && row.first_scene_data
        ? { firstScene: row.first_scene_data }
        : {}),
    }));
    return ownerJson({ courses }, 200, responseHeaders);
  });
}

// POST /api/my-courses — apply one favorite/learned/cover action.
export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const { action, stageId, favorite, coverUrl } = body as {
    action?: unknown;
    stageId?: unknown;
    favorite?: unknown;
    coverUrl?: unknown;
  };
  if (action !== 'favorite' && action !== 'learned' && action !== 'cover') {
    return apiError('INVALID_REQUEST', 400, 'action must be favorite, learned, or cover');
  }
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  }
  if (action === 'favorite' && typeof favorite !== 'boolean') {
    return apiError('INVALID_REQUEST', 400, 'favorite must be a boolean');
  }
  if (action === 'cover' && typeof coverUrl !== 'string' && coverUrl !== null) {
    return apiError('INVALID_REQUEST', 400, 'coverUrl must be a string or null');
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const pool = await getAdminPool();

    if (action === 'favorite') {
      // Favoriting needs no ownership: a published course can be favorited by
      // anyone, exactly like bookmarking. resolveStageAccess applies the
      // tombstone, so a deleted course answers the plain 404.
      const access = await resolveStageAccess(stageId);
      if (!access) return ownerNotFound(responseHeaders);
      if (favorite) {
        await pool.query(
          `INSERT INTO course_favorites (owner_id, stage_id)
           VALUES ($1, $2)
           ON CONFLICT (owner_id, stage_id) DO NOTHING`,
          [ownerId, stageId],
        );
      } else {
        await pool.query('DELETE FROM course_favorites WHERE owner_id = $1 AND stage_id = $2', [
          ownerId,
          stageId,
        ]);
      }
      return ownerJson({ success: true, favorite }, 200, responseHeaders);
    }

    if (action === 'learned') {
      // An admin course preview (打开课程 from the console) resolves to the
      // course owner's identity — recording it would pollute the owner's
      // learning history with the admin's inspection, so the touch is a
      // silent no-op while a preview cookie is active.
      if (coursePreviewOwnerId(req) !== null) {
        return ownerJson({ success: true }, 200, responseHeaders);
      }
      // The classroom mount touch: bump last_learned_at and count the visit.
      // A foreign id is still a legitimate touch (learning someone else's
      // published course is the product), so only existence is checked.
      const access = await resolveStageAccess(stageId);
      if (!access) return ownerNotFound(responseHeaders);
      await pool.query(
        `INSERT INTO course_learning (owner_id, stage_id, last_learned_at, learn_count)
         VALUES ($1, $2, now(), 1)
         ON CONFLICT (owner_id, stage_id)
         DO UPDATE SET last_learned_at = now(), learn_count = course_learning.learn_count + 1`,
        [ownerId, stageId],
      );
      return ownerJson({ success: true }, 200, responseHeaders);
    }

    // action === 'cover': the cover lives on course_user_meta keyed by stage
    // alone — it is shared by every viewer — so only the owner may set it.
    const access = await resolveStageAccess(stageId);
    if (!access) return ownerNotFound(responseHeaders);
    if (access.ownerId !== ownerId) {
      return ownerApiError(
        'INVALID_REQUEST',
        403,
        'only the course owner may set the cover',
        responseHeaders,
      );
    }
    await pool.query(
      `INSERT INTO course_user_meta (stage_id, cover_url, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (stage_id) DO UPDATE SET cover_url = $2, updated_at = now()`,
      [stageId, coverUrl ?? null],
    );
    return ownerJson({ success: true, coverUrl: coverUrl ?? null }, 200, responseHeaders);
  });
}
