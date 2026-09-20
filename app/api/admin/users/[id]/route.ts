/** /api/admin/users/[id] — update (真实姓名/status/password) or remove one end-user account. No role. */
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { hashAdminPassword } from '@/lib/admin/crypto';
import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, ctx: Params) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return apiError('INVALID_REQUEST', 400, '非法的用户 ID');

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (typeof body.displayName === 'string') push('display_name', body.displayName.trim() || null);
  if (body.status === 'active' || body.status === 'disabled') push('status', body.status);
  if (typeof body.password === 'string') {
    if (body.password.length < 6) return apiError('INVALID_REQUEST', 400, '密码至少 6 位');
    push('password_hash', hashAdminPassword(body.password));
  }
  if (sets.length === 0) {
    return apiError('INVALID_REQUEST', 400, '没有需要更新的字段');
  }
  push('updated_at', new Date());
  params.push(id);

  const pool = await getAdminPool();
  const result = await pool.query(
    `UPDATE user_accounts SET ${sets.join(', ')}
     WHERE id = $${params.length}
     RETURNING id, username, display_name, avatar_url, nickname, status, created_at, updated_at`,
    params,
  );
  if (result.rows.length === 0) return apiError('INVALID_REQUEST', 404, '用户不存在');

  await recordAudit(guard.session, {
    action: 'user.update',
    targetType: 'user_account',
    targetId: id,
    detail: {
      fields: sets.map((s) => s.split(' =')[0]),
      passwordChanged: typeof body.password === 'string',
    },
    ip: requestIp(request),
  });
  return Response.json({ success: true, user: result.rows[0] });
}

export async function DELETE(request: Request, ctx: Params) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return apiError('INVALID_REQUEST', 400, '非法的用户 ID');

  const pool = await getAdminPool();
  const result = await pool.query('DELETE FROM user_accounts WHERE id = $1 RETURNING username', [
    id,
  ]);
  if (result.rows.length === 0) return apiError('INVALID_REQUEST', 404, '用户不存在');

  await recordAudit(guard.session, {
    action: 'user.delete',
    targetType: 'user_account',
    targetId: id,
    detail: { username: result.rows[0].username },
    ip: requestIp(request),
  });
  return Response.json({ success: true });
}
