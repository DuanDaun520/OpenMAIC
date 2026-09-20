/**
 * GET /api/admin/auth/me — session probe for the admin SPA shell.
 * Answers the session identity plus deployment facts the UI surfaces
 * (encryption configured, database reachable).
 */
import { isAdminSecretConfigured } from '@/lib/admin/crypto';
import { requireAdmin } from '@/lib/admin/auth';
import { isDatabaseConfigured } from '@/lib/admin/db';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  return Response.json({
    success: true,
    admin: guard.session,
    deployment: {
      databaseConfigured: isDatabaseConfigured(),
      encryptionConfigured: isAdminSecretConfigured(),
    },
  });
}
