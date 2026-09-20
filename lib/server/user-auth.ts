/**
 * Product end-user authentication — session cookie + DB-backed sessions.
 *
 * The third identity plane alongside the anonymous owner (agent-runtime
 * `owner.ts`) and the admin console (`lib/admin/auth.ts`). Product users are
 * the `user_accounts` rows the admin console manages (created there; there is
 * no self-registration by design — accounts are distributed). Sessions live in
 * their own `user_sessions` table and cookie, so an admin session grants no
 * product surface and vice versa. As with admin sessions, only the SHA-256 of
 * the session token is stored: a database read cannot mint a session.
 */
import { createHash, randomBytes } from 'crypto';
import type { NextResponse } from 'next/server';

import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { hashAdminPassword, verifyAdminPassword } from '@/lib/admin/crypto';

export const USER_SESSION_COOKIE = 'openmaic_user_session';
export const USER_REQUEST_HEADER = 'x-user-request';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The avatar every account is created with (and the fallback when a client
 * has none yet) — matches `AVATAR_OPTIONS[0]` in the learner profile store. */
export const DEFAULT_AVATAR_URL = '/avatars/user-3.png';

export interface UserSession {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  nickname: string | null;
  bio: string | null;
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Login rate limiting (per process, bounded) — same posture as admin login.
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
// Credential check + session lifecycle
// ---------------------------------------------------------------------------

export async function authenticateUser(params: {
  username: string;
  password: string;
  clientKey: string;
}): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const { username, password, clientKey } = params;
  if (loginLimited(clientKey)) {
    return { ok: false, error: '尝试次数过多，请 15 分钟后再试' };
  }
  const pool = await getAdminPool();
  const result = await pool.query<{ id: string; password_hash: string; status: string }>(
    'SELECT id, password_hash, status FROM user_accounts WHERE username = $1',
    [username],
  );
  const user = result.rows[0];
  if (!user || !verifyAdminPassword(password, user.password_hash)) {
    recordLoginFailure(clientKey);
    return { ok: false, error: '用户名或密码错误' };
  }
  if (user.status !== 'active') {
    return { ok: false, error: '该账号已被停用，请联系管理员' };
  }
  clearLoginFailures(clientKey);
  return { ok: true, userId: user.id };
}

export async function createUserSession(params: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const pool = await getAdminPool();
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.userId,
      hashSessionToken(token),
      expiresAt,
      params.ip ?? null,
      params.userAgent ?? null,
    ],
  );
  // Opportunistic expired-row cleanup, bounded by login frequency — keeps the
  // table from growing unbounded on a long-lived server with no scheduler.
  await pool.query('DELETE FROM user_sessions WHERE expires_at < now()').catch(() => undefined);
  return { token, expiresAt };
}

export async function validateUserSession(
  token: string | undefined | null,
): Promise<UserSession | null> {
  if (!token || !isDatabaseConfigured()) return null;
  const pool = await getAdminPool();
  const result = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    nickname: string | null;
    bio: string | null;
    status: string;
  }>(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.nickname, u.bio, u.status
     FROM user_sessions s
     JOIN user_accounts u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'active') return null;
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? DEFAULT_AVATAR_URL,
    nickname: row.nickname,
    bio: row.bio,
  };
}

export async function destroyUserSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const pool = await getAdminPool();
  await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}

/** Change the logged-in user's password: verify the old one first, then drop
 * every OTHER session so a stolen cookie dies with the rotation. */
export async function changeUserPassword(params: {
  userId: string;
  oldPassword: string;
  newPassword: string;
}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (params.newPassword.length < 6 || params.newPassword.length > 128) {
    return { ok: false, error: '新密码需为 6-128 个字符' };
  }
  const pool = await getAdminPool();
  const result = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM user_accounts WHERE id = $1',
    [params.userId],
  );
  const user = result.rows[0];
  if (!user || !verifyAdminPassword(params.oldPassword, user.password_hash)) {
    return { ok: false, error: '当前密码不正确' };
  }
  await pool.query(
    'UPDATE user_accounts SET password_hash = $2, updated_at = now() WHERE id = $1',
    [params.userId, hashAdminPassword(params.newPassword)],
  );
  // Rotate: kill all sessions, then mint exactly one for the caller so they
  // stay logged in across the change.
  await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [params.userId]);
  const session = await createUserSession({ userId: params.userId });
  return { ok: true, token: session.token };
}

export function readUserSessionToken(request: Pick<Request, 'headers'>): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === USER_SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

export function userSessionCookieOptions(request: Request, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** Attach (or clear) the session cookie on any NextResponse. */
export function withUserSessionCookie(
  response: NextResponse,
  request: Request,
  token: string | null,
  maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000),
): NextResponse {
  response.cookies.set(USER_SESSION_COOKIE, token ?? '', {
    ...userSessionCookieOptions(request, token ? maxAgeSeconds : 0),
  });
  return response;
}

export type UserGuard = { ok: true; session: UserSession } | { ok: false; response: NextResponse };

/** Guard for user-authenticated API routes: validates the session cookie and,
 * on mutations, requires the same-origin marker header (SameSite=Lax already
 * blocks cross-site fetch cookie attachment; this closes the rest). */
export async function requireUser(
  request: Request,
  options: { mutation?: boolean } = {},
): Promise<UserGuard> {
  const { NextResponse: NR } = await import('next/server');
  if (options.mutation && request.headers.get(USER_REQUEST_HEADER) !== '1') {
    return {
      ok: false,
      response: NR.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '缺少请求头' },
        { status: 403 },
      ),
    };
  }
  const token = readUserSessionToken(request);
  const session = await validateUserSession(token).catch(() => null);
  if (!session) {
    return {
      ok: false,
      response: NR.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '未登录或会话已过期' },
        { status: 401 },
      ),
    };
  }
  return { ok: true, session };
}
