/**
 * Admin audit trail — one row per privileged mutation. Best-effort by design:
 * an audit write failure must never fail the mutation it records, but it
 * should be visible in server logs.
 */
import type { AdminSession } from '@/lib/admin/auth';
import { getAdminPool } from '@/lib/admin/db';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

export async function recordAudit(session: AdminSession, entry: AuditEntry): Promise<void> {
  try {
    const pool = await getAdminPool();
    await pool.query(
      `INSERT INTO audit_logs (admin_user_id, admin_username, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        session.userId,
        session.username,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ip ?? null,
      ],
    );
  } catch (error) {
    console.error('[admin] audit write failed', entry.action, error);
  }
}

export function requestIp(request: Request): string | undefined {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    undefined
  );
}
