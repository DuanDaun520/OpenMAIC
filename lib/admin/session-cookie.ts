/**
 * Standalone constant so edge/proxy code can reference the admin cookie name
 * without importing the DB-bound auth module (`lib/admin/auth.ts`).
 */
export const ADMIN_SESSION_COOKIE = 'openmaic_admin_session';
