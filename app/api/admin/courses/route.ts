/**
 * /api/admin/courses — cross-owner course administration.
 *
 * Reads `document_stages` (tombstone-filtered) and joins the admin side
 * tables for category + publication state, plus the card-facing projections
 * the console list renders: description, AI cover, generation status, and the
 * owner's display name (user accounts resolve via the `user:<uuid>` owner id;
 * anonymous owners show as 匿名用户).
 *
 * - GET    list with search + pagination.
 * - PATCH  { stageId, action }: 'publish' | 'archive' | 'draft' |
 *          'feature' | 'unfeature' (推荐到首页 — implies published) |
 *          'setCategory' | 'clearCategory' | 'setTags' |
 *          'updateInfo' { name?, description? } — rides the owner-bound
 *          document store under the course's real owner, so the write path
 *          (updated_at, plain-JSON boundary) is exactly the owner's own;
 *          'setOwner' { ownerUserId } — transfer authorship;
 *          'beginPreview'/'endPreview' — mint/clear the signed preview
 *          cookie that lets the admin open /classroom/:id as the owner.
 * - DELETE { stageId } — HARD delete: document rows (scenes/outlines/stage_meta
 *          cascade), admin side tables, asset references, and the classroom's
 *          on-disk media directory. Unlike the owner-facing delete (a
 *          tombstone plus deferred byte reclamation), this is the console's
 *          explicit "remove everything" lever and is unrecoverable.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { beginCoursePreviewCookie, endCoursePreviewCookie } from '@/lib/admin/course-preview';
import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import {
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
} from '@/lib/server/agent-runtime/stage-limits';
import {
  courseGenerationStatus,
  type CourseGenerationFacts,
} from '@/lib/server/course-generation-status';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Stage ids are minted ids (`stage-<base64url>` / classroom nanoid), never paths. */
const SAFE_STAGE_ID_RE = /^[A-Za-z0-9_-]+$/;

interface ListRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  owner_nickname: string | null;
  owner_display_name: string | null;
  owner_username: string | null;
  created_at: Date;
  updated_at: Date;
  updated_ms: number;
  scene_count: string;
  publish_status: 'draft' | 'published' | 'archived';
  featured: boolean | null;
  category_id: string | null;
  category_name: string | null;
  cover_url: string | null;
  generation_complete: boolean | null;
  outline_generation_complete: string | null;
  generation_heartbeat_at: number | null;
  tags: { id: string; name: string }[];
  user_deleted_at: Date | string | null;
}

/** The shared SELECT/WHERE of the list and its count — kept in one string so
 * the two can never drift on filters (tombstones above all). */
const LIST_SELECT = `
  FROM document_stages s
  LEFT JOIN stage_meta m ON m.stage_id = s.id
  LEFT JOIN document_outlines o ON o.stage_id = s.id
  LEFT JOIN course_publications pub ON pub.stage_id = s.id
  LEFT JOIN course_category_map ccm ON ccm.stage_id = s.id
  LEFT JOIN course_categories cat ON cat.id = ccm.category_id
  LEFT JOIN course_user_meta cov ON cov.stage_id = s.id
  LEFT JOIN user_accounts ua ON s.owner_id = 'user:' || ua.id::text
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.sort_order, t.name),
      '[]'::json
    ) AS tags
    FROM course_tag_map ctm
    JOIN course_tags t ON t.id = ctm.tag_id
    WHERE ctm.stage_id = s.id
  ) tags ON TRUE
`;

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  if (!process.env.DATABASE_URL) {
    return apiError('INTERNAL_ERROR', 503, '课程管理需要配置 DATABASE_URL');
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get('query') ?? '').trim();
  const status = url.searchParams.get('status') ?? '';
  const categoryId = url.searchParams.get('categoryId') ?? '';
  const tagId = url.searchParams.get('tagId') ?? '';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20),
  );

  const pool = await getAdminPool();
  const params: unknown[] = [];
  // Base predicate: tombstones stay out of the default view, but the explicit
  // 用户已删除 filter flips the list to show EXACTLY those soft-deleted rows
  // (the user's delete is a mark, not a removal — admins must still see them).
  const where: string[] = [
    status === 'userDeleted' ? `m.deleted_at IS NOT NULL` : `COALESCE(m.deleted_at IS NULL, TRUE)`,
  ];
  if (query) {
    params.push(`%${query}%`);
    where.push(`s.name ILIKE $${params.length}`);
  }
  if (status === 'published' || status === 'archived' || status === 'draft') {
    params.push(status);
    where.push(`COALESCE(pub.status, 'draft') = $${params.length}`);
  }
  if (categoryId && UUID_RE.test(categoryId)) {
    params.push(categoryId);
    where.push(`ccm.category_id = $${params.length}`);
  }
  if (tagId && UUID_RE.test(tagId)) {
    params.push(tagId);
    where.push(
      `EXISTS (SELECT 1 FROM course_tag_map ctm WHERE ctm.stage_id = s.id AND ctm.tag_id = $${params.length})`,
    );
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const total = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count ${LIST_SELECT} ${whereSql}`,
    params,
  );
  const rows = await pool.query<ListRow>(
    `SELECT s.id, s.name, s.description, s.owner_id,
            ua.nickname AS owner_nickname, ua.display_name AS owner_display_name,
            ua.username AS owner_username,
            to_timestamp(s.created_at / 1000) AS created_at,
            to_timestamp(s.updated_at / 1000) AS updated_at,
            s.updated_at AS updated_ms,
            (SELECT COUNT(*) FROM document_scenes sc WHERE sc.stage_id = s.id) AS scene_count,
            COALESCE(pub.status, 'draft') AS publish_status,
            pub.featured,
            ccm.category_id, cat.name AS category_name,
            cov.cover_url,
            m.generation_complete,
            o.data ->> 'generationComplete' AS outline_generation_complete,
            m.generation_heartbeat_at,
            m.deleted_at AS user_deleted_at,
            tags.tags AS tags
     ${LIST_SELECT}
     ${whereSql}
     ORDER BY s.updated_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  const now = Date.now();
  return Response.json({
    success: true,
    courses: rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      owner_id: row.owner_id,
      // 真实姓名 (display_name) first — the console lists people, not handles;
      // nickname/工号 only stand in when the account never set one.
      owner_name: row.owner_display_name ?? row.owner_nickname ?? row.owner_username ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      scene_count: row.scene_count,
      publish_status: row.publish_status,
      featured: row.featured === true,
      category_id: row.category_id,
      category_name: row.category_name,
      cover_url: row.cover_url,
      generation_status: courseGenerationStatus(
        {
          generationComplete: row.generation_complete,
          outlineGenerationComplete: row.outline_generation_complete,
          generationHeartbeatAt: row.generation_heartbeat_at,
          updatedAtMs: row.updated_ms,
        } satisfies CourseGenerationFacts,
        now,
      ),
      tags: row.tags,
      user_deleted_at: row.user_deleted_at ?? null,
    })),
    total: Number(total.rows[0]?.count ?? 0),
    page,
    pageSize,
  });
}

/** The course's acting owner: stage_meta is authoritative, the document row
 * is the fallback for a stage whose meta row has not caught up. */
async function loadStageOwner(
  pool: Awaited<ReturnType<typeof getAdminPool>>,
  stageId: string,
): Promise<{ name: string; ownerId: string } | null> {
  const result = await pool.query<{ name: string; owner_id: string | null }>(
    `SELECT s.name, COALESCE(m.owner_id, s.owner_id) AS owner_id
       FROM document_stages s
       LEFT JOIN stage_meta m ON m.stage_id = s.id
      WHERE s.id = $1`,
    [stageId],
  );
  const row = result.rows[0];
  if (!row || !row.owner_id) return null;
  return { name: row.name, ownerId: row.owner_id };
}

export async function PATCH(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  const action = typeof body.action === 'string' ? body.action : '';
  if (!stageId) return apiError('INVALID_REQUEST', 400, '需要 stageId');

  const pool = await getAdminPool();
  const exists = await pool.query('SELECT 1 FROM document_stages WHERE id = $1', [stageId]);
  if (exists.rows.length === 0) return apiError('INVALID_REQUEST', 404, '课程不存在');

  let previewCookie: string | undefined;

  switch (action) {
    case 'publish':
    case 'archive':
    case 'draft': {
      // Action verbs (publish/archive) map onto the status vocabulary
      // (published/archived) the list filter and UI badges expect. Unshelving
      // (draft/archive) also drops the 首页 flag — the homepage grid is a
      // subset of the published shelf, never a side door around it.
      const status =
        action === 'publish' ? 'published' : action === 'archive' ? 'archived' : 'draft';
      await pool.query(
        `INSERT INTO course_publications (stage_id, status, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (stage_id) DO UPDATE
           SET status = EXCLUDED.status,
               featured = CASE WHEN EXCLUDED.status = 'published'
                               THEN course_publications.featured ELSE FALSE END,
               updated_at = now()`,
        [stageId, status],
      );
      break;
    }
    case 'feature': {
      // 推荐到首页 — homepage curation on top of the shelf. Featuring implies
      // publishing: the homepage grid is a subset of 学习天地, never a side
      // door around publication.
      await pool.query(
        `INSERT INTO course_publications (stage_id, status, featured, updated_at)
         VALUES ($1, 'published', TRUE, now())
         ON CONFLICT (stage_id) DO UPDATE
           SET status = 'published', featured = TRUE, updated_at = now()`,
        [stageId],
      );
      break;
    }
    case 'unfeature': {
      // 从首页撤下 keeps the publication status — unfeaturing is not unshelving.
      await pool.query(
        `UPDATE course_publications SET featured = FALSE, updated_at = now() WHERE stage_id = $1`,
        [stageId],
      );
      break;
    }
    case 'setCategory': {
      const categoryId = typeof body.categoryId === 'string' ? body.categoryId : '';
      if (!categoryId || !UUID_RE.test(categoryId)) {
        return apiError('INVALID_REQUEST', 400, '需要有效的 categoryId');
      }
      await pool.query(
        `INSERT INTO course_category_map (stage_id, category_id, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (stage_id) DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = now()`,
        [stageId, categoryId],
      );
      break;
    }
    case 'clearCategory': {
      await pool.query('DELETE FROM course_category_map WHERE stage_id = $1', [stageId]);
      break;
    }
    case 'setTags': {
      // Full replace: the UI sends the complete intended tag set, so the
      // write is delete-then-insert of the (validated, deduped) id list.
      const raw = body.tagIds;
      if (
        !Array.isArray(raw) ||
        raw.some((value) => typeof value !== 'string' || !UUID_RE.test(value))
      ) {
        return apiError('INVALID_REQUEST', 400, 'tagIds 需为标签 ID 数组');
      }
      if (raw.length > 50) return apiError('INVALID_REQUEST', 400, '一门课程最多 50 个标签');
      const tagIds = [...new Set(raw)];
      // A tag deleted between the UI's list load and this save is a silent
      // no-op rather than an FK failure — same end state the delete caused.
      const existing =
        tagIds.length > 0
          ? await pool.query<{ id: string }>('SELECT id FROM course_tags WHERE id = ANY($1)', [
              tagIds,
            ])
          : { rows: [] as { id: string }[] };
      await pool.query('DELETE FROM course_tag_map WHERE stage_id = $1', [stageId]);
      if (existing.rows.length > 0) {
        await pool.query(
          `INSERT INTO course_tag_map (stage_id, tag_id, updated_at)
           SELECT $1, id, now() FROM course_tags WHERE id = ANY($2)
           ON CONFLICT (stage_id, tag_id) DO NOTHING`,
          [stageId, existing.rows.map((row) => row.id)],
        );
      }
      break;
    }
    case 'updateInfo': {
      // The console's 修改课程信息 — same field contract as the owner's
      // PATCH /api/stages/[id], but authority is the admin session and the
      // write rides the owner-bound store under the course's real owner so
      // the storage-domain invariants (updated_at bump, plain-JSON boundary)
      // hold identically.
      const stage = await loadStageOwner(pool, stageId);
      if (!stage) return apiError('INVALID_REQUEST', 409, '课程没有所有者，无法通过存储域写入');
      const rawName = body.name;
      const rawDescription = body.description;
      if (rawName === undefined && rawDescription === undefined) {
        return apiError('INVALID_REQUEST', 400, '需要 name 和/或 description');
      }
      let name: string | undefined;
      if (rawName !== undefined) {
        if (typeof rawName !== 'string' || rawName.trim().length === 0) {
          return apiError('INVALID_REQUEST', 400, 'name must be a non-empty string');
        }
        name = rawName.trim();
        if (name.length > STAGE_NAME_MAX_LENGTH) {
          return apiError(
            'INVALID_REQUEST',
            400,
            `name exceeds the ${STAGE_NAME_MAX_LENGTH} character limit`,
          );
        }
      }
      let description: string | null | undefined;
      if (rawDescription !== undefined) {
        if (rawDescription === null) {
          description = null;
        } else if (typeof rawDescription === 'string') {
          description = rawDescription.trim() || null;
          if (description !== null && description.length > STAGE_DESCRIPTION_MAX_LENGTH) {
            return apiError(
              'INVALID_REQUEST',
              400,
              `description exceeds the ${STAGE_DESCRIPTION_MAX_LENGTH} character limit`,
            );
          }
        } else {
          return apiError('INVALID_REQUEST', 400, 'description must be a string or null');
        }
      }
      const store = await getOwnerScopedDocumentStore(stage.ownerId);
      const document = await store.loadDocument(stageId);
      if (!document) return apiError('INVALID_REQUEST', 404, '课程不存在');
      // A null description must DROP the member (the store's write boundary
      // treats undefined-valued members as absent) — see /api/stages/[id].
      const nextStage = { ...document.stage };
      if (name !== undefined) nextStage.name = name;
      if (description === null) delete nextStage.description;
      else if (description !== undefined) nextStage.description = description;
      nextStage.updatedAt = Date.now();
      try {
        await store.saveDocument({ ...document, stage: nextStage });
      } catch (error) {
        return apiError(
          'INTERNAL_ERROR',
          500,
          error instanceof Error ? error.message : '保存课程信息失败',
        );
      }
      break;
    }
    case 'setOwner': {
      // Transfer authorship. Both owner columns move together: stage_meta is
      // the authoritative access plane, document_stages.owner_id the store's
      // scope predicate. Favorites/learning rows stay with their owners —
      // they are per-owner relationships, not course property.
      const ownerUserId = typeof body.ownerUserId === 'string' ? body.ownerUserId.trim() : '';
      if (!ownerUserId || !ownerUserId.startsWith('user:') || !UUID_RE.test(ownerUserId.slice(5))) {
        return apiError('INVALID_REQUEST', 400, 'ownerUserId 需为 user:<uuid>');
      }
      const user = await pool.query('SELECT 1 FROM user_accounts WHERE id = $1', [
        ownerUserId.slice(5),
      ]);
      if (user.rows.length === 0) return apiError('INVALID_REQUEST', 404, '目标用户不存在');
      await pool.query('UPDATE document_stages SET owner_id = $2 WHERE id = $1', [
        stageId,
        ownerUserId,
      ]);
      await pool.query(
        `INSERT INTO stage_meta (stage_id, owner_id)
         VALUES ($1, $2)
         ON CONFLICT (stage_id) DO UPDATE SET owner_id = EXCLUDED.owner_id`,
        [stageId, ownerUserId],
      );
      break;
    }
    case 'setCover': {
      // The console editor's 恢复默认: clear the shared AI cover. Same target
      // as the owner's /api/my-courses {action:'cover'} write.
      const coverUrl = body.coverUrl;
      if (typeof coverUrl !== 'string' && coverUrl !== null) {
        return apiError('INVALID_REQUEST', 400, 'coverUrl must be a string or null');
      }
      await pool.query(
        `INSERT INTO course_user_meta (stage_id, cover_url, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (stage_id) DO UPDATE SET cover_url = $2, updated_at = now()`,
        [stageId, coverUrl ?? null],
      );
      break;
    }
    case 'beginPreview': {
      // Mint the signed preview cookie; the client then opens /classroom/:id
      // in a new tab, where the product surface treats the admin as the
      // course's owner (editable) and the learning touch is suppressed.
      const stage = await loadStageOwner(pool, stageId);
      if (!stage) return apiError('INVALID_REQUEST', 409, '课程没有所有者，无法预览');
      previewCookie = beginCoursePreviewCookie(stage.ownerId);
      break;
    }
    case 'endPreview': {
      previewCookie = endCoursePreviewCookie();
      break;
    }
    default:
      return apiError('INVALID_REQUEST', 400, '未知 action');
  }

  await recordAudit(guard.session, {
    action: `course.${action}`,
    targetType: 'course',
    targetId: stageId,
    detail: {
      categoryId: body.categoryId,
      tagIds: body.tagIds,
      name: body.name,
      ownerUserId: body.ownerUserId,
    },
    ip: requestIp(request),
  });
  const response = Response.json({ success: true });
  if (previewCookie) response.headers.append('Set-Cookie', previewCookie);
  return response;
}

// DELETE /api/admin/courses — remove a course ENTIRELY: document rows (the
// stage row cascades scenes/outlines/stage_meta), admin side tables, asset
// references (entries drain through the collector's grace, exactly like the
// owner-facing tombstone path), and the classroom's on-disk media directory.
// The body mirrors PATCH ({ stageId }) rather than a query parameter so the
// destructive target cannot drift through URL rewriting.
export async function DELETE(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  if (!process.env.DATABASE_URL) {
    return apiError('INTERNAL_ERROR', 503, '课程管理需要配置 DATABASE_URL');
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  if (!stageId || !SAFE_STAGE_ID_RE.test(stageId)) {
    return apiError('INVALID_REQUEST', 400, '需要 stageId');
  }

  const pool = await getAdminPool();
  const client = await pool.connect();
  let mediaRemoved = false;
  try {
    await client.query('BEGIN');
    const stage = await client.query<{ name: string; owner_id: string | null }>(
      'SELECT name, owner_id FROM document_stages WHERE id = $1',
      [stageId],
    );
    if (stage.rows.length === 0) {
      await client.query('ROLLBACK');
      return apiError('INVALID_REQUEST', 404, '课程不存在');
    }

    // Asset references: same statements the storage package's removal helper
    // runs (it is deliberately not re-exported) — collect the stage's asset
    // ids, drop the reference rows, then stamp entries that lost their last
    // reference so the scheduled collector frees the bytes after grace. On a
    // database whose asset tables predate reference tracking this is a no-op.
    const hasRefsTable = await client.query<{ oid: string | null }>(
      `SELECT to_regclass('public.document_asset_refs')::oid AS oid`,
    );
    if (hasRefsTable.rows[0]?.oid) {
      const assets = await client.query<{ asset_id: string }>(
        'SELECT DISTINCT asset_id FROM document_asset_refs WHERE stage_id = $1',
        [stageId],
      );
      await client.query('DELETE FROM document_asset_refs WHERE stage_id = $1', [stageId]);
      if (assets.rows.length > 0) {
        await client.query(
          `UPDATE asset_entries ae
              SET unreferenced_at = COALESCE(ae.unreferenced_at, now())
            WHERE ae.id = ANY($1)
              AND ae.unreferenced_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM document_asset_refs r WHERE r.asset_id = ae.id
              )`,
          [assets.rows.map((row) => row.asset_id)],
        );
      }
    }

    // Admin-side course state, then the document row itself (stage_meta,
    // scenes and outlines go by their ON DELETE CASCADE foreign keys).
    for (const table of [
      'course_publications',
      'course_category_map',
      'course_tag_map',
      'course_user_meta',
      'course_favorites',
      'course_learning',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE stage_id = $1`, [stageId]);
    }
    await client.query('DELETE FROM document_stages WHERE id = $1', [stageId]);
    await client.query('COMMIT');

    // Filesystem media (AI covers, generated images, narration audio) — the
    // directory belongs to this stage exclusively, so it goes wholesale. A
    // failure here leaves the rows deleted (the course is already gone from
    // every product surface); the orphaned directory is cache-grade litter.
    try {
      await rm(path.join(CLASSROOMS_DIR, stageId), { recursive: true, force: true });
      mediaRemoved = true;
    } catch {
      mediaRemoved = false;
    }

    await recordAudit(guard.session, {
      action: 'course.delete',
      targetType: 'course',
      targetId: stageId,
      detail: {
        name: stage.rows[0].name,
        ownerId: stage.rows[0].owner_id,
        mediaRemoved,
      },
      ip: requestIp(request),
    });
    return Response.json({ success: true, mediaRemoved });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : '删除课程失败');
  } finally {
    client.release();
  }
}
