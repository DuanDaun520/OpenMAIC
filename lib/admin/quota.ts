/**
 * Quota engine for generation calls.
 *
 * Balances bind to the product identity string (the owner id — `anon:<uuid>`
 * today, an authenticated principal later), NOT to user_accounts: the check
 * works for today's anonymous owners and keeps working when real logins
 * replace the cookie identity.
 *
 * Enforcement is double-switched OFF by default: `OPENMAIC_QUOTA_ENFORCED=1`
 * in the deployment AND the global policy's `enforcement` flag (console
 * toggle). With either off, every check is a cheap no-op and generate routes
 * behave exactly as before — a fresh deployment never rate-limits itself by
 * accident.
 *
 * Grants are idempotent per owner per day: the "daily reset" is a lazy grant
 * applied on the owner's first check of the day, so no scheduler exists to
 * break. `initial_amount` applies once, when the owner's account is created
 * by first sight.
 */
import { NextResponse } from 'next/server';

import { readAuthAwareOwnerId } from '@/lib/server/agent-runtime/auth-owner';
import { isDatabaseConfigured } from '@/lib/admin/db';
import { getAdminPool } from '@/lib/admin/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('Quota');

export interface QuotaPolicy {
  dailyAmount: number;
  initialAmount: number;
  enforcement: boolean;
}

export async function getQuotaPolicy(): Promise<QuotaPolicy> {
  const pool = await getAdminPool();
  const result = await pool.query<{
    daily_amount: string;
    initial_amount: string;
    enforcement: boolean;
  }>(
    'SELECT daily_amount::text, initial_amount::text, enforcement FROM quota_policies WHERE id = $1',
    ['global'],
  );
  const row = result.rows[0];
  return {
    dailyAmount: Number(row?.daily_amount ?? 0),
    initialAmount: Number(row?.initial_amount ?? 0),
    enforcement: !!row?.enforcement,
  };
}

export async function setQuotaPolicy(patch: Partial<QuotaPolicy>): Promise<QuotaPolicy> {
  const pool = await getAdminPool();
  const current = await getQuotaPolicy();
  const next = { ...current, ...patch };
  await pool.query(
    `UPDATE quota_policies SET daily_amount = $1, initial_amount = $2, enforcement = $3, updated_at = now()
     WHERE id = 'global'`,
    [next.dailyAmount, next.initialAmount, next.enforcement],
  );
  return next;
}

/** Effective enforcement: deployment env switch AND console policy switch. */
export async function isQuotaEnforced(): Promise<boolean> {
  if (process.env.OPENMAIC_QUOTA_ENFORCED !== '1') return false;
  if (!isDatabaseConfigured()) return false;
  try {
    return (await getQuotaPolicy()).enforcement;
  } catch {
    return false; // a broken DB must not lock everyone out
  }
}

export interface QuotaAccount {
  ownerKey: string;
  balance: number;
  dailyLastReset: string | null;
  updatedAt: string;
}

/** pg delivers DATE columns as Date objects at LOCAL midnight; format from
 * local parts so the day survives (toISOString would shift it to the previous
 * UTC day). */
function formatDateOnly(value: unknown): string | null {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return value ? String(value) : null;
}

/**
 * Ensure the owner has a quota row, applying the initial grant on first sight
 * and the daily grant on the first sight of each day. Returns the fresh row.
 */
export async function ensureQuotaAccount(ownerKey: string): Promise<QuotaAccount> {
  const pool = await getAdminPool();
  const policy = await getQuotaPolicy();

  const inserted = await pool.query<{
    balance: string;
    daily_last_reset: Date | null;
    updated_at: Date;
  }>(
    `INSERT INTO user_quotas (owner_key, balance)
     VALUES ($1, $2)
     ON CONFLICT (owner_key) DO NOTHING
     RETURNING balance::text, daily_last_reset, updated_at`,
    [ownerKey, policy.initialAmount],
  );
  if (inserted.rows[0] && policy.initialAmount > 0) {
    await pool.query(
      `INSERT INTO quota_grants (owner_key, amount, reason, note)
       VALUES ($1, $2, 'initial', '首次创建额度账户自动发放')`,
      [ownerKey, policy.initialAmount],
    );
  }

  // Lazy daily grant: one row per owner-day, recorded like any other grant.
  if (policy.dailyAmount > 0) {
    const granted = await pool.query(
      `UPDATE user_quotas
       SET balance = balance + $2,
           daily_last_reset = CURRENT_DATE,
           updated_at = now()
       WHERE owner_key = $1 AND (daily_last_reset IS NULL OR daily_last_reset < CURRENT_DATE)
       RETURNING 1`,
      [ownerKey, policy.dailyAmount],
    );
    if (granted.rowCount) {
      await pool.query(
        `INSERT INTO quota_grants (owner_key, amount, reason, note)
         VALUES ($1, $2, 'daily', '每日自动发放')`,
        [ownerKey, policy.dailyAmount],
      );
    }
  }

  const fresh = await pool.query<{
    balance: string;
    daily_last_reset: Date | null;
    updated_at: Date;
  }>('SELECT balance::text, daily_last_reset, updated_at FROM user_quotas WHERE owner_key = $1', [
    ownerKey,
  ]);
  const row = fresh.rows[0];
  return {
    ownerKey,
    balance: Number(row?.balance ?? 0),
    dailyLastReset: formatDateOnly(row?.daily_last_reset),
    updatedAt: row?.updated_at?.toISOString?.() ?? String(row?.updated_at ?? ''),
  };
}

export type QuotaCheckResult = { ok: true; remaining: number } | { ok: false; remaining: number };

/**
 * Check (and debit) one call unit for the owner. When enforcement is off —
 * the default — this resolves to `{ ok: true }` without touching the
 * database, so generate routes gain no latency and no behavior change.
 */
export async function checkAndConsumeQuota(ownerKey: string): Promise<QuotaCheckResult> {
  if (!(await isQuotaEnforced())) return { ok: true, remaining: Infinity };
  const account = await ensureQuotaAccount(ownerKey);
  if (account.balance <= 0) return { ok: false, remaining: 0 };

  const debited = await getAdminPool().then((pool) =>
    pool.query(
      'UPDATE user_quotas SET balance = balance - 1, updated_at = now() WHERE owner_key = $1 AND balance > 0 RETURNING balance::text',
      [ownerKey],
    ),
  );
  if (!debited.rows[0]) return { ok: false, remaining: 0 };
  return { ok: true, remaining: Number(debited.rows[0].balance) };
}

/**
 * Route-entry guard: null when the call may proceed (enforcement off, owner
 * unattributable, or balance debited); a 402-shaped NextResponse when
 * exhausted. Unattributable owners (no anonymous cookie yet) are allowed —
 * there is nothing to debit, and rejecting them would break first-run UX.
 */
export async function quotaGateForRequest(request: Request): Promise<NextResponse | null> {
  if (!(await isQuotaEnforced())) return null;
  const ownerKey = await readAuthAwareOwnerId(request);
  if (!ownerKey) return null;
  const result = await checkAndConsumeQuota(ownerKey).catch((error) => {
    log.warn('quota check failed; allowing the call', error);
    return { ok: true as const, remaining: Infinity };
  });
  if (result.ok) return null;
  return NextResponse.json(
    {
      success: false,
      errorCode: 'QUOTA_EXHAUSTED',
      error: '调用额度已用尽，请联系管理员充值',
    },
    { status: 402 },
  );
}

/** Admin adjustment: positive tops up, negative deducts (floored at zero). */
export async function adjustQuota(params: {
  ownerKey: string;
  amount: number;
  reason?: string;
  note?: string;
  grantedBy?: string;
}): Promise<QuotaAccount> {
  const pool = await getAdminPool();
  await ensureQuotaAccount(params.ownerKey);
  await pool.query(
    'UPDATE user_quotas SET balance = GREATEST(0, balance + $2), updated_at = now() WHERE owner_key = $1',
    [params.ownerKey, params.amount],
  );
  await pool.query(
    `INSERT INTO quota_grants (owner_key, amount, reason, note, granted_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.ownerKey,
      params.amount,
      params.reason ?? 'admin',
      params.note ?? null,
      params.grantedBy ?? null,
    ],
  );
  return ensureQuotaAccountBalancesOnly(params.ownerKey);
}

async function ensureQuotaAccountBalancesOnly(ownerKey: string): Promise<QuotaAccount> {
  const pool = await getAdminPool();
  const row = await pool.query<{
    balance: string;
    daily_last_reset: Date | null;
    updated_at: Date;
  }>('SELECT balance::text, daily_last_reset, updated_at FROM user_quotas WHERE owner_key = $1', [
    ownerKey,
  ]);
  const record = row.rows[0];
  return {
    ownerKey,
    balance: Number(record?.balance ?? 0),
    dailyLastReset: formatDateOnly(record?.daily_last_reset),
    updatedAt: record?.updated_at?.toISOString?.() ?? String(record?.updated_at ?? ''),
  };
}

export async function listQuotaAccounts(): Promise<QuotaAccount[]> {
  const pool = await getAdminPool();
  const rows = await pool.query<{
    owner_key: string;
    balance: string;
    daily_last_reset: Date | null;
    updated_at: Date;
  }>(
    'SELECT owner_key, balance::text, daily_last_reset, updated_at FROM user_quotas ORDER BY updated_at DESC LIMIT 200',
  );
  return rows.rows.map((row) => ({
    ownerKey: row.owner_key,
    balance: Number(row.balance),
    dailyLastReset: formatDateOnly(row.daily_last_reset),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export interface QuotaGrantRow {
  id: number;
  ownerKey: string;
  amount: number;
  reason: string;
  note: string | null;
  grantedBy: string | null;
  grantedAt: string;
}

export async function listRecentQuotaGrants(limit = 50): Promise<QuotaGrantRow[]> {
  const pool = await getAdminPool();
  const rows = await pool.query<{
    id: string;
    owner_key: string;
    amount: string;
    reason: string;
    note: string | null;
    granted_by: string | null;
    granted_at: Date;
  }>(
    'SELECT id::text, owner_key, amount::text, reason, note, granted_by, granted_at FROM quota_grants ORDER BY granted_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map((row) => ({
    id: Number(row.id),
    ownerKey: row.owner_key,
    amount: Number(row.amount),
    reason: row.reason,
    note: row.note,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at.toISOString(),
  }));
}
