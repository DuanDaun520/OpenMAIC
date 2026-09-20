/**
 * /api/admin/users — platform end-user account management (P0).
 *
 * These are the product's learners/teachers (`user_accounts`), a separate
 * population from console administrators (`admin_users`). No role concept:
 * 工号 (username) identifies the account, 真实姓名 (display_name) is the
 * admin-maintained name, and avatar/AI 昵称 are user-managed in the product
 * (PATCH /api/auth/profile) — read back here for the console table.
 * New accounts start with the default preset avatar.
 */
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { hashAdminPassword } from '@/lib/admin/crypto';
import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { DEFAULT_AVATAR_URL } from '@/lib/server/user-auth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const query = (url.searchParams.get('query') ?? '').trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20),
  );

  const pool = await getAdminPool();
  const params: unknown[] = [];
  const where = query ? `WHERE username ILIKE $1 OR display_name ILIKE $1` : '';
  if (query) params.push(`%${query}%`);

  const total = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM user_accounts ${where}`,
    params,
  );
  const rows = await pool.query(
    `SELECT id, username, display_name, avatar_url, nickname, status, org_id, owner_cookie, created_at, updated_at
     FROM user_accounts ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  return Response.json({
    success: true,
    users: rows.rows,
    total: Number(total.rows[0]?.count ?? 0),
    page,
    pageSize,
  });
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
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : null;
  const status = body.status === 'disabled' ? 'disabled' : 'active';

  if (!/^[a-zA-Z0-9_.-]{2,64}$/.test(username)) {
    return apiError('INVALID_REQUEST', 400, '用户名需为 2-64 位字母/数字/_.-');
  }
  if (password.length < 6) {
    return apiError('INVALID_REQUEST', 400, '密码至少 6 位');
  }

  const pool = await getAdminPool();
  try {
    const result = await pool.query(
      `INSERT INTO user_accounts (username, password_hash, display_name, avatar_url, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, display_name, avatar_url, nickname, status, created_at, updated_at`,
      [username, hashAdminPassword(password), displayName, DEFAULT_AVATAR_URL, status],
    );
    await recordAudit(guard.session, {
      action: 'user.create',
      targetType: 'user_account',
      targetId: result.rows[0].id,
      detail: { username, status },
      ip: requestIp(request),
    });
    return Response.json({ success: true, user: result.rows[0] }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('unique')) {
      return apiError('INVALID_REQUEST', 409, '用户名已存在');
    }
    throw error;
  }
}
