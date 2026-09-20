/**
 * PATCH /api/auth/profile — the logged-in user's presentation identity:
 * avatar (a preset path or the client-resized data-URL), AI nickname, and
 * bio. Partial updates only; the response mirrors /api/auth/me so callers
 * can adopt the stored values without a second round-trip.
 */
import { NextResponse } from 'next/server';

import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { DEFAULT_AVATAR_URL, requireUser } from '@/lib/server/user-auth';

export const runtime = 'nodejs';

const PRESET_AVATAR = /^\/avatars\/[A-Za-z0-9._-]+\.png$/;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,/;
/** ~200 KB once base64-decoded. Real uploads are 128×128 JPEGs of a few KB —
 * this is purely a safety cap on what may land in the column. */
const MAX_AVATAR_LENGTH = 280_000;
const MAX_NICKNAME_LENGTH = 20;
const MAX_BIO_LENGTH = 200;

function validAvatarUrl(value: string): boolean {
  if (PRESET_AVATAR.test(value)) return true;
  return AVATAR_DATA_URL.test(value) && value.length <= MAX_AVATAR_LENGTH;
}

export async function PATCH(request: Request) {
  const guard = await requireUser(request, { mutation: true });
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if ('avatarUrl' in body) {
    const raw = body.avatarUrl;
    const avatarUrl =
      raw === null
        ? DEFAULT_AVATAR_URL
        : typeof raw === 'string'
          ? raw.trim()
          : '';
    if (!validAvatarUrl(avatarUrl)) {
      return apiError('INVALID_REQUEST', 400, '头像格式不正确或超出大小限制');
    }
    params.push(avatarUrl);
    sets.push(`avatar_url = $${params.length}`);
  }

  for (const [field, column, maxLength, label] of [
    ['nickname', 'nickname', MAX_NICKNAME_LENGTH, '昵称'],
    ['bio', 'bio', MAX_BIO_LENGTH, '个人简介'],
  ] as const) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw !== null && typeof raw !== 'string') {
      return apiError('INVALID_REQUEST', 400, `${label}格式不正确`);
    }
    const value = raw === null ? '' : raw.trim();
    if (value.length > maxLength) {
      return apiError('INVALID_REQUEST', 400, `${label}不能超过 ${maxLength} 个字符`);
    }
    params.push(value === '' ? null : value);
    sets.push(`${column} = $${params.length}`);
  }

  if (sets.length === 0) {
    return apiError('INVALID_REQUEST', 400, '没有可更新的字段');
  }

  const pool = await getAdminPool();
  params.push(guard.session.userId);
  const result = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    nickname: string | null;
    bio: string | null;
  }>(
    `UPDATE user_accounts SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length}
     RETURNING id, username, display_name, avatar_url, nickname, bio`,
    params,
  );
  const user = result.rows[0];
  return NextResponse.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url ?? DEFAULT_AVATAR_URL,
      nickname: user.nickname,
      bio: user.bio,
    },
  });
}
