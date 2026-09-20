/**
 * /api/admin/categories — course category tree management (P1).
 *
 * - GET    all categories with course counts.
 * - POST   { name, parentId?, sortOrder? } create.
 * - PATCH  { id, name?, sortOrder?, parentId? } rename / reorder / reparent
 *          (parentId: null = move to top level; cycles are refused).
 * - DELETE ?id= remove; the category map cascades (courses stay, just
 *          uncategorized).
 */
import type { Pool } from 'pg';

import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether moving `id` under `candidateParentId` would cycle the tree — i.e.
 * the candidate parent sits inside `id`'s own subtree. Walks up the ancestry
 * chain (bounded; a corrupted cycle in stored data cannot loop forever).
 */
async function wouldCreateCycle(
  pool: Pool,
  candidateParentId: string,
  id: string,
): Promise<boolean> {
  let cursor: string | null = candidateParentId;
  for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
    // Annotated on purpose: `up`'s own type inference reads the values array,
    // so feeding it the narrowed `cursor` directly is a circular inference.
    const current: string = cursor;
    if (current === id) return true;
    const up = await pool.query<{ parent_id: string | null }>(
      'SELECT parent_id FROM course_categories WHERE id = $1',
      [current],
    );
    cursor = up.rows[0]?.parent_id ?? null;
  }
  return false;
}

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const pool = await getAdminPool();
  const rows = await pool.query(
    `SELECT c.id, c.parent_id, c.name, c.sort_order, c.created_at,
            (SELECT COUNT(*) FROM course_category_map m WHERE m.category_id = c.id) AS course_count
     FROM course_categories c ORDER BY c.sort_order, c.created_at`,
  );
  return Response.json({ success: true, categories: rows.rows });
}

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const parentId =
    typeof body.parentId === 'string' && UUID_RE.test(body.parentId) ? body.parentId : null;
  if (!name || name.length > 64) {
    return apiError('INVALID_REQUEST', 400, '分类名需为 1-64 个字符');
  }

  const pool = await getAdminPool();
  if (parentId) {
    const parent = await pool.query('SELECT 1 FROM course_categories WHERE id = $1', [parentId]);
    if (parent.rows.length === 0) return apiError('INVALID_REQUEST', 404, '父分类不存在');
  }
  const sortOrder =
    body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))
      ? Math.trunc(Number(body.sortOrder))
      : 0;
  const result = await pool.query(
    'INSERT INTO course_categories (name, parent_id, sort_order) VALUES ($1, $2, $3) RETURNING id, name, parent_id, sort_order, created_at',
    [name, parentId, sortOrder],
  );
  await recordAudit(guard.session, {
    action: 'category.create',
    targetType: 'course_category',
    targetId: result.rows[0].id,
    detail: { name, parentId },
    ip: requestIp(request),
  });
  return Response.json({ success: true, category: result.rows[0] }, { status: 201 });
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
  const id = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : '';
  if (!id) return apiError('INVALID_REQUEST', 400, '需要有效的分类 ID');

  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof body.name === 'string' && body.name.trim()) {
    params.push(body.name.trim());
    sets.push(`name = $${params.length}`);
  }
  if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
    params.push(Math.trunc(Number(body.sortOrder)));
    sets.push(`sort_order = $${params.length}`);
  }
  // Reparenting: present means "set to this parent" (null = 顶级). A move
  // under the category's own descendant would cycle the subtree, so walk up
  // from the candidate parent and refuse if this id is on that ancestry chain.
  let nextParentId: string | null | undefined;
  if ('parentId' in body) {
    nextParentId =
      typeof body.parentId === 'string' && UUID_RE.test(body.parentId) ? body.parentId : null;
  }
  if (nextParentId === id) {
    return apiError('INVALID_REQUEST', 400, '分类不能作为自己的父分类');
  }

  const pool = await getAdminPool();
  if (nextParentId !== undefined && nextParentId !== null) {
    const parent = await pool.query('SELECT 1 FROM course_categories WHERE id = $1', [
      nextParentId,
    ]);
    if (parent.rows.length === 0) return apiError('INVALID_REQUEST', 404, '父分类不存在');
    if (await wouldCreateCycle(pool, nextParentId, id)) {
      return apiError('INVALID_REQUEST', 400, '不能把分类移动到它自己的子分类下');
    }
  }
  if (nextParentId !== undefined) {
    params.push(nextParentId);
    sets.push(`parent_id = $${params.length}`);
  }
  if (sets.length === 0) return apiError('INVALID_REQUEST', 400, '没有需要更新的字段');

  params.push(id);
  const result = await pool.query(
    `UPDATE course_categories SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, parent_id, sort_order, created_at`,
    params,
  );
  if (result.rows.length === 0) return apiError('INVALID_REQUEST', 404, '分类不存在');

  await recordAudit(guard.session, {
    action: 'category.update',
    targetType: 'course_category',
    targetId: id,
    detail: { fields: sets.map((s) => s.split(' =')[0]) },
    ip: requestIp(request),
  });
  return Response.json({ success: true, category: result.rows[0] });
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return apiError('INVALID_REQUEST', 400, '需要有效的分类 ID');

  const pool = await getAdminPool();
  const result = await pool.query('DELETE FROM course_categories WHERE id = $1 RETURNING name', [
    id,
  ]);
  if (result.rows.length === 0) return apiError('INVALID_REQUEST', 404, '分类不存在');

  await recordAudit(guard.session, {
    action: 'category.delete',
    targetType: 'course_category',
    targetId: id,
    detail: { name: result.rows[0].name },
    ip: requestIp(request),
  });
  return Response.json({ success: true });
}
