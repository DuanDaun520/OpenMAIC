/**
 * /api/admin/tags — course tag management (P1).
 *
 * - GET    all tags with course counts.
 * - POST   { name } create (names are unique labels).
 * - PATCH  { id, name?, sortOrder? } rename / reorder.
 * - DELETE ?id= remove; the tag map cascades (courses keep everything else).
 */
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres unique-violation — surfaced as a friendly duplicate-name error. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const pool = await getAdminPool();
  const rows = await pool.query(
    `SELECT t.id, t.name, t.sort_order, t.created_at,
            (SELECT COUNT(*) FROM course_tag_map m WHERE m.tag_id = t.id) AS course_count
     FROM course_tags t ORDER BY t.sort_order, t.created_at`,
  );
  return Response.json({ success: true, tags: rows.rows });
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
  if (!name || name.length > 32) {
    return apiError('INVALID_REQUEST', 400, '标签名需为 1-32 个字符');
  }

  const pool = await getAdminPool();
  let created: { id: string; name: string; sort_order: number; created_at: string };
  try {
    const result = await pool.query(
      'INSERT INTO course_tags (name) VALUES ($1) RETURNING id, name, sort_order, created_at',
      [name],
    );
    created = result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) return apiError('INVALID_REQUEST', 409, '同名标签已存在');
    throw error;
  }
  await recordAudit(guard.session, {
    action: 'tag.create',
    targetType: 'course_tag',
    targetId: created.id,
    detail: { name },
    ip: requestIp(request),
  });
  return Response.json({ success: true, tag: created }, { status: 201 });
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
  if (!id) return apiError('INVALID_REQUEST', 400, '需要有效的标签 ID');

  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof body.name === 'string' && body.name.trim()) {
    const name = body.name.trim();
    if (name.length > 32) return apiError('INVALID_REQUEST', 400, '标签名需为 1-32 个字符');
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
    params.push(Math.trunc(Number(body.sortOrder)));
    sets.push(`sort_order = $${params.length}`);
  }
  if (sets.length === 0) return apiError('INVALID_REQUEST', 400, '没有需要更新的字段');

  const pool = await getAdminPool();
  params.push(id);
  let updated: { id: string; name: string } | undefined;
  try {
    const result = await pool.query(
      `UPDATE course_tags SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, sort_order, created_at`,
      params,
    );
    updated = result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) return apiError('INVALID_REQUEST', 409, '同名标签已存在');
    throw error;
  }
  if (!updated) return apiError('INVALID_REQUEST', 404, '标签不存在');

  await recordAudit(guard.session, {
    action: 'tag.update',
    targetType: 'course_tag',
    targetId: id,
    detail: { fields: sets.map((s) => s.split(' =')[0]) },
    ip: requestIp(request),
  });
  return Response.json({ success: true, tag: updated });
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID_RE.test(id)) return apiError('INVALID_REQUEST', 400, '需要有效的标签 ID');

  const pool = await getAdminPool();
  const result = await pool.query<{ name: string }>(
    'DELETE FROM course_tags WHERE id = $1 RETURNING name',
    [id],
  );
  if (result.rows.length === 0) return apiError('INVALID_REQUEST', 404, '标签不存在');

  await recordAudit(guard.session, {
    action: 'tag.delete',
    targetType: 'course_tag',
    targetId: id,
    detail: { name: result.rows[0].name },
    ip: requestIp(request),
  });
  return Response.json({ success: true });
}
