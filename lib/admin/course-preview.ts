/**
 * Admin course-preview impersonation — a short-lived, signed cookie that lets
 * an authenticated admin browse the product surface (打开课程 → /classroom/:id)
 * acting as a course's real owner.
 *
 * Why impersonation rather than a bespoke admin viewer: the classroom's whole
 * edit path (stage-meta `isOwner`, /api/stages writes, the persistence route's
 * document access, generation calls) is uniformly keyed on the owner identity
 * resolved per request. Minting the owner identity itself — instead of
 * teaching every product route about a second privilege plane — keeps the
 * admin preview exactly as capable as the owner's own session, for free.
 *
 * Shape: `<ownerId>.<expiresEpochMs>.<hmacSha256(ownerId.expires)>`, keyed by
 * a scrypt-derived key from OPENMAIC_ADMIN_SECRET (the same deployment secret
 * behind the provider-key cipher). Without the secret — plain local dev,
 * where the default admin account also exists — a fixed development key is
 * used so the feature stays testable; the cookie is HttpOnly and only ever
 * grants what the signing admin already had.
 */
import { createHmac, scryptSync, timingSafeEqual } from 'crypto';

export const COURSE_PREVIEW_COOKIE = 'openmaic_admin_preview';

/** Preview windows are deliberately short: re-minted on every 打开 click. */
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const KEY_LENGTH = 32;
/** Owner ids are `user:<uuid>` / `anon:<uuid>` — anything else is not ours. */
const PREVIEW_OWNER_RE =
  /^(user|anon):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function derivePreviewKey(): Buffer {
  // Fixed salt is deliberate, matching deriveAesKey in ./crypto.ts: the
  // derived key must be stable across processes and restarts.
  const secret = process.env.OPENMAIC_ADMIN_SECRET?.trim() || 'openmaic-local-dev-course-preview';
  return scryptSync(secret, 'openmaic-admin-course-preview', KEY_LENGTH);
}

function sign(payload: string): string {
  return createHmac('sha256', derivePreviewKey()).update(payload).digest('hex');
}

function previewCookieSecure(): boolean {
  // Mirrors the anonymous owner cookie's posture (agent-runtime/owner.ts).
  return process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
}

/** Set-Cookie value that begins (or re-mints) a preview of `ownerId`. */
export function beginCoursePreviewCookie(ownerId: string): string {
  const expires = Date.now() + PREVIEW_TTL_MS;
  // Owner ids (`user:<uuid>` / `anon:<uuid>`) are cookie-octet safe, so the
  // value travels verbatim: the cookie reader URL-decodes on the way in,
  // and signing the verbatim id keeps mint and verify over the same bytes.
  const value = `${ownerId}.${expires}.${sign(`${ownerId}.${expires}`)}`;
  const secure = previewCookieSecure() ? '; Secure' : '';
  return (
    `${COURSE_PREVIEW_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${Math.floor(PREVIEW_TTL_MS / 1000)}${secure}`
  );
}

/** Set-Cookie value that ends any active preview. */
export function endCoursePreviewCookie(): string {
  return `${COURSE_PREVIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(headers: Headers, name: string): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The impersonated owner id when the request carries a valid, unexpired
 * preview cookie; null otherwise. Tampering (bad HMAC, expired, malformed)
 * reads as "no preview" — never throws.
 */
export function coursePreviewOwnerId(req: Pick<Request, 'headers'>): string | null {
  // The cookie reader URL-decodes the value; owner ids carry no dots, so the
  // three-part structure survives verbatim.
  const raw = readCookie(req.headers, COURSE_PREVIEW_COOKIE);
  if (!raw) return null;
  const dot1 = raw.indexOf('.');
  const dot2 = raw.lastIndexOf('.');
  if (dot1 <= 0 || dot2 <= dot1) return null;
  const expiresText = raw.slice(dot1 + 1, dot2);
  const expires = Number(expiresText);
  if (!Number.isInteger(expires) || expires <= Date.now()) return null;
  const ownerId = raw.slice(0, dot1);
  if (!PREVIEW_OWNER_RE.test(ownerId)) return null;
  const signature = raw.slice(dot2 + 1);
  const expected = sign(`${ownerId}.${expiresText}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return ownerId;
}
