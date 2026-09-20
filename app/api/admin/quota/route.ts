/**
 * /api/admin/quota — quota policy + per-owner balances (P1).
 *
 * - GET   policy, accounts (bounded 200), recent grants.
 * - PUT   policy update ({ dailyAmount?, initialAmount?, enforcement? }).
 * - POST  manual adjustment ({ ownerKey, amount, note? }) — positive tops up,
 *         negative deducts; recorded as a grant row either way.
 *
 * Enforcement is the AND of OPENMAIC_QUOTA_ENFORCED=1 and the policy switch;
 * the PUT response reports the effective state so the UI can show what's
 * missing.
 */
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import {
  adjustQuota,
  getQuotaPolicy,
  isQuotaEnforced,
  listQuotaAccounts,
  listRecentQuotaGrants,
  setQuotaPolicy,
} from '@/lib/admin/quota';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const [policy, accounts, grants, enforced] = await Promise.all([
    getQuotaPolicy(),
    listQuotaAccounts(),
    listRecentQuotaGrants(),
    isQuotaEnforced(),
  ]);
  return Response.json({
    success: true,
    policy,
    accounts,
    grants,
    enforced,
    envFlagSet: process.env.OPENMAIC_QUOTA_ENFORCED === '1',
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }

  const patch: { dailyAmount?: number; initialAmount?: number; enforcement?: boolean } = {};
  if (body.dailyAmount !== undefined) {
    const value = Number(body.dailyAmount);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
      return apiError('INVALID_REQUEST', 400, 'dailyAmount 需为 0-1000000 的数字');
    }
    patch.dailyAmount = value;
  }
  if (body.initialAmount !== undefined) {
    const value = Number(body.initialAmount);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
      return apiError('INVALID_REQUEST', 400, 'initialAmount 需为 0-1000000 的数字');
    }
    patch.initialAmount = value;
  }
  if (body.enforcement !== undefined) patch.enforcement = Boolean(body.enforcement);

  const policy = await setQuotaPolicy(patch);
  await recordAudit(guard.session, {
    action: 'quota.policy_update',
    targetType: 'quota_policy',
    targetId: 'global',
    detail: patch,
    ip: requestIp(request),
  });
  return Response.json({
    success: true,
    policy,
    enforced: await isQuotaEnforced(),
    envFlagSet: process.env.OPENMAIC_QUOTA_ENFORCED === '1',
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
  const ownerKey = typeof body.ownerKey === 'string' ? body.ownerKey.trim() : '';
  const amount = Number(body.amount);
  const note = typeof body.note === 'string' ? body.note.trim() : undefined;
  if (!ownerKey || ownerKey.length > 200) {
    return apiError('INVALID_REQUEST', 400, '需要有效的 ownerKey');
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return apiError('INVALID_REQUEST', 400, 'amount 需为非零数字（正数充值、负数扣减）');
  }

  const account = await adjustQuota({
    ownerKey,
    amount,
    reason: 'admin',
    note,
    grantedBy: guard.session.username,
  });
  await recordAudit(guard.session, {
    action: 'quota.adjust',
    targetType: 'user_quota',
    targetId: ownerKey,
    detail: { amount, note },
    ip: requestIp(request),
  });
  return Response.json({ success: true, account });
}
