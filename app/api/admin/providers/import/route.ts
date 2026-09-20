/**
 * POST /api/admin/providers/import — "configuration lives in the database":
 * import the env/YAML provider configuration into `provider_configs`.
 *
 * This runs inside the server process on purpose. The app's module graph
 * assumes a bundler context, so a standalone Node script cannot load the
 * config-loading code (the workspace storage package is ESM-only); running
 * here also means the import sees exactly the environment the deployment runs
 * with — no separate-tool env drift, and OPENMAIC_ADMIN_SECRET is the right
 * one by construction. The same import also runs automatically once on first
 * boot (lib/server/provider-config-persist.ts) when the table is still empty;
 * this route is the console's explicit, previewable version of it.
 *
 * Body: { dryRun?: boolean, force?: boolean }
 *  - dryRun returns the plan (what would import / what would skip) without
 *    writing; the console shows it for confirmation before the real call.
 *  - force overwrites rows that already exist. Default is skip: console edits
 *    always win over the config files.
 *
 * After a real import the rows go live through the write-through overlay
 * patch (this process) and the TTL refresh (others) — no restart. Never
 * returns key material, only a masked tail like the PUT route.
 */
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { isAdminSecretConfigured } from '@/lib/admin/crypto';
import { getAdminPool } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { loadEnvYamlServerConfig } from '@/lib/server/provider-config';
import { persistProviderConfigRow } from '@/lib/server/provider-config-persist';
import { buildProviderConfigImportRows } from '@/lib/server/provider-config-import';

export const runtime = 'nodejs';

interface ImportPlanRow {
  capability: string;
  providerId: string;
  hasApiKey: boolean;
  apiKeyTail: string | null;
  /** Field names of extra credentials riding the row (AliDocMind AK/SK). */
  extraSecretFields: string[];
  baseUrl: string | null;
  models: string[];
  proxy: string | null;
  enabled: boolean;
  willSkip: boolean;
}

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  let body: { dryRun?: unknown; force?: unknown };
  try {
    body = (await request.json()) as { dryRun?: unknown; force?: unknown };
  } catch {
    body = {};
  }
  const dryRun = body.dryRun === true;
  const force = body.force === true;

  const rows = buildProviderConfigImportRows(loadEnvYamlServerConfig());

  const warnings: string[] = [];
  if (!isAdminSecretConfigured()) {
    warnings.push(
      '未设置 OPENMAIC_ADMIN_SECRET，导入的 API Key 将以明文标记存储（仅限本地开发）。',
    );
  }

  const pool = await getAdminPool();
  const existing = await pool.query<{ capability: string; provider_id: string }>(
    'SELECT capability, provider_id FROM provider_configs',
  );
  const existingKeys = new Set(existing.rows.map((row) => `${row.capability}:${row.provider_id}`));
  const willSkip = (capability: string, providerId: string) =>
    !force && existingKeys.has(`${capability}:${providerId}`);

  const plan: ImportPlanRow[] = rows.map((row) => ({
    capability: row.capability,
    providerId: row.providerId,
    hasApiKey: !!row.apiKey,
    apiKeyTail: row.apiKey ? `••••${row.apiKey.slice(-4)}` : null,
    extraSecretFields: Object.keys(row.extraSecrets),
    baseUrl: row.baseUrl,
    models: row.models,
    proxy: row.proxy,
    enabled: row.enabled,
    willSkip: willSkip(row.capability, row.providerId),
  }));

  if (dryRun) {
    return Response.json({
      success: true,
      dryRun: true,
      plan,
      counts: {
        total: plan.length,
        toImport: plan.filter((row) => !row.willSkip).length,
        skipped: plan.filter((row) => row.willSkip).length,
      },
      warnings,
    });
  }

  const writable = rows.filter((row) => !willSkip(row.capability, row.providerId));
  for (const row of writable) {
    // Upsert + write-through overlay patch, shared with the bootstrap seed.
    await persistProviderConfigRow(row, guard.session.userId);
  }

  await recordAudit(guard.session, {
    action: 'provider.import',
    targetType: 'provider_config',
    targetId: 'env-yaml',
    detail: { imported: writable.length, skipped: rows.length - writable.length, force },
    ip: requestIp(request),
  });

  return Response.json({
    success: true,
    imported: writable.length,
    skipped: rows.length - writable.length,
    warnings,
  });
}

// The method gate matters less than the admin guard, but keeping this route
// POST-only documents that it is a mutation surface.
export function GET(): Response {
  return apiError('INVALID_REQUEST', 405, 'use POST');
}
