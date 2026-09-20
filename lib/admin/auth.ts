/**
 * Admin authentication — session cookie + DB-backed sessions + API guard.
 *
 * Deliberately separate from the product's anonymous-owner identity (see
 * `lib/server/agent-runtime/owner.ts`): admin sessions live in their own
 * tables and their own cookie, so compromising the product surface grants no
 * admin surface and vice versa. Token shape follows the persistence route's
 * posture — only the SHA-256 of the session token is stored, so a database
 * read cannot mint a session.
 */
import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import type { Pool } from 'pg';

import { getAdminPool } from '@/lib/admin/db';
import { verifyAdminPassword } from '@/lib/admin/crypto';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/session-cookie';

export { ADMIN_SESSION_COOKIE };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type AdminRole = 'super_admin' | 'admin' | 'operator';

export interface AdminSession {
  userId: string;
  username: string;
  role: AdminRole;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Login rate limiting (per process, bounded)
// ---------------------------------------------------------------------------

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, number[]>();

function loginLimited(key: string): boolean {
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  return recent.length >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  recent.push(now);
  loginFailures.set(key, recent);
  if (loginFailures.size > 10_000) {
    const oldest = loginFailures.keys().next().value;
    if (oldest !== undefined) loginFailures.delete(oldest);
  }
}

function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createAdminSession(params: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const pool = await getAdminPool();
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.userId,
      hashSessionToken(token),
      expiresAt,
      params.ip ?? null,
      params.userAgent ?? null,
    ],
  );
  // Opportunistic cleanup of expired rows — bounded by this process's login
  // frequency, and keeps the table from growing unbounded on long-lived dev
  // servers without adding a scheduler.
  await pool.query('DELETE FROM admin_sessions WHERE expires_at < now()').catch(() => undefined);
  return { token, expiresAt };
}

export async function validateAdminSession(
  token: string | undefined | null,
): Promise<AdminSession | null> {
  if (!token) return null;
  const pool: Pool = await getAdminPool();
  const result = await pool.query<{
    id: string;
    username: string;
    role: string;
    status: string;
  }>(
    `SELECT u.id, u.username, u.role, u.status
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.admin_user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'active') return null;
  return {
    userId: row.id,
    username: row.username,
    role: (row.role as AdminRole) ?? 'operator',
  };
}

export async function destroyAdminSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const pool = await getAdminPool();
  await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}

export async function authenticateAdmin(params: {
  username: string;
  password: string;
  clientKey: string;
}): Promise<
  { ok: true; userId: string; username: string; role: AdminRole } | { ok: false; error: string }
> {
  const { username, password, clientKey } = params;
  if (loginLimited(clientKey)) {
    return { ok: false, error: '尝试次数过多，请 15 分钟后再试' };
  }
  const pool = await getAdminPool();
  const result = await pool.query<{
    id: string;
    password_hash: string;
    role: string;
    status: string;
  }>('SELECT id, password_hash, role, status FROM admin_users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user || !verifyAdminPassword(password, user.password_hash)) {
    recordLoginFailure(clientKey);
    return { ok: false, error: '用户名或密码错误' };
  }
  if (user.status !== 'active') {
    return { ok: false, error: '该管理员已被停用' };
  }
  clearLoginFailures(clientKey);
  await pool
    .query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id])
    .catch(() => undefined);
  return {
    ok: true,
    userId: user.id,
    username,
    role: (user.role as AdminRole) ?? 'operator',
  };
}

// ---------------------------------------------------------------------------
// Route guard
// ---------------------------------------------------------------------------

export type AdminGuard =
  | { ok: true; session: AdminSession }
  | { ok: false; response: NextResponse };

/**
 * Guard for `/api/admin/*` routes: validates the session cookie against the
 * database and enforces the mutation CSRF header. `proxy.ts` performs only an
 * optimistic cookie-presence check; this is the authoritative gate.
 */
export async function requireAdmin(
  request: Request,
  options: { mutation?: boolean; minRole?: AdminRole } = {},
): Promise<AdminGuard> {
  // Cookies can only be attached cross-site for top-level navigations under
  // SameSite=Lax; requiring this custom header on mutations closes the rest.
  if (options.mutation && request.headers.get('x-admin-request') !== '1') {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: 'Missing x-admin-request header' },
        { status: 403 },
      ),
    };
  }
  const token = readSessionToken(request);
  const session = await validateAdminSession(token).catch(() => null);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '未登录或会话已过期' },
        { status: 401 },
      ),
    };
  }
  if (options.minRole && roleRank(session.role) < roleRank(options.minRole)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '权限不足' },
        { status: 403 },
      ),
    };
  }
  return { ok: true, session };
}

function roleRank(role: AdminRole): number {
  switch (role) {
    case 'super_admin':
      return 3;
    case 'admin':
      return 2;
    default:
      return 1;
  }
}

export function readSessionToken(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === ADMIN_SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

/** Build the login/logout Set-Cookie for the session cookie. */
export function sessionCookieOptions(request: Request, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
