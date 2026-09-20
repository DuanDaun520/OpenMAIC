/**
 * /api/admin/providers — provider configuration management (P0).
 *
 * - GET     lists every DB-managed row (keys masked to their tail) plus the
 *           effective managed provider ids per capability, so the UI can mark
 *           each provider's origin: DB row, env/YAML, or unmanaged.
 * - PUT     upserts one (capability, providerId) row. Omitting `apiKey`
 *           keeps the stored key; empty string clears it. The in-memory
 *           overlay is patched synchronously after the DB commit, so the
 *           running server picks up the change on the next request without a
 *           restart — the whole point of DB-first configuration.
 * - DELETE  removes a row, falling that provider back to env/YAML.
 *
 * Effective runtime values are never returned here: keys go out masked, and
 * base URLs/models are shown from the DB row only.
 */
import { NextResponse } from 'next/server';

import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import {
  encryptSecret,
  isAdminSecretConfigured,
  markPlainSecret,
  maskSecretTail,
} from '@/lib/admin/crypto';
import { getAdminPool } from '@/lib/admin/db';
import {
  ADMIN_CAPABILITIES,
  type AdminCapability,
  type ProviderConfigRow,
  loadProviderConfigRows,
  patchProviderConfigRow,
} from '@/lib/admin/provider-overrides';
import { apiError } from '@/lib/server/api-response';
import {
  getServerASRProviders,
  getServerImageProviders,
  getServerPDFProviders,
  getServerProviders,
  getServerTTSProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
} from '@/lib/server/provider-config';

export const runtime = 'nodejs';

function effectiveManagedIds(): Record<string, string[]> {
  return {
    llm: Object.keys(getServerProviders()),
    tts: Object.keys(getServerTTSProviders()),
    asr: Object.keys(getServerASRProviders()),
    pdf: Object.keys(getServerPDFProviders()),
    image: Object.keys(getServerImageProviders()),
    video: Object.keys(getServerVideoProviders()),
    websearch: Object.keys(getServerWebSearchProviders()),
  };
}

function toClientRow(row: ProviderConfigRow) {
  // Masked tails for extra credentials (AliDocMind AK/SK) — same write-only
  // treatment as the API key.
  const extraSecretTails: Record<string, string | null> = {};
  for (const [field, cipher] of Object.entries(row.extraSecrets ?? {})) {
    extraSecretTails[field] = maskSecretTail(cipher);
  }
  return {
    capability: row.capability,
    providerId: row.providerId,
    hasApiKey: !!row.apiKeyCipher,
    apiKeyTail: maskSecretTail(row.apiKeyCipher),
    extraSecretTails,
    baseUrl: row.baseUrl,
    models: row.models,
    proxy: row.proxy,
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const rows = await loadProviderConfigRows();
  const managed = effectiveManagedIds();
  const dbIds = new Set(rows.map((row) => `${row.capability}:${row.providerId}`));
  const envOnly: Record<string, string[]> = {};
  for (const capability of ADMIN_CAPABILITIES) {
    // `managed` is keyed by capability (its llm/websearch entries already map
    // to the right server sections internally).
    envOnly[capability] = (managed[capability] ?? []).filter(
      (id) => !dbIds.has(`${capability}:${id}`),
    );
  }

  return Response.json({
    success: true,
    rows: rows.map(toClientRow),
    envOnly,
    encryptionConfigured: isAdminSecretConfigured(),
  });
}

interface ProviderPutBody {
  capability?: unknown;
  providerId?: unknown;
  apiKey?: unknown;
  /** Extra credentials (AliDocMind AK/SK): field → string, same tri-state as apiKey. */
  extraSecrets?: unknown;
  baseUrl?: unknown;
  models?: unknown;
  proxy?: unknown;
  enabled?: unknown;
}

/** Fields allowed in the extra_secrets column. */
const EXTRA_SECRET_FIELDS = ['accessKeyId', 'accessKeySecret'] as const;

export async function PUT(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  let body: ProviderPutBody;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }

  const capability = typeof body.capability === 'string' ? body.capability : '';
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
  if (!(ADMIN_CAPABILITIES as readonly string[]).includes(capability)) {
    return apiError('INVALID_REQUEST', 400, `capability 必须是 ${ADMIN_CAPABILITIES.join('/')}`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) {
    return apiError('INVALID_REQUEST', 400, 'providerId 格式不合法');
  }

  const models = Array.isArray(body.models)
    ? body.models.map((m) => String(m).trim()).filter(Boolean)
    : undefined;
  if (models && models.length > 50) {
    return apiError('INVALID_REQUEST', 400, 'models 数量过多（上限 50）');
  }

  const cap = capability as AdminCapability;
  const pool = await getAdminPool();
  const existing = await pool.query<{
    api_key_cipher: string | null;
    extra_secrets: Record<string, string> | null;
  }>(
    'SELECT api_key_cipher, extra_secrets FROM provider_configs WHERE capability = $1 AND provider_id = $2',
    [cap, providerId],
  );

  // Omitted apiKey keeps the stored cipher; empty string clears it; a value
  // encrypts — or falls back to a marked plaintext when OPENMAIC_ADMIN_SECRET
  // is unset (local dev), which the GET response surfaces to the UI.
  let apiKeyCipher: string | null | undefined;
  if (body.apiKey === undefined) {
    apiKeyCipher = existing.rows[0]?.api_key_cipher ?? null;
  } else if (body.apiKey === '') {
    apiKeyCipher = null;
  } else if (typeof body.apiKey === 'string') {
    apiKeyCipher = isAdminSecretConfigured()
      ? encryptSecret(body.apiKey)
      : markPlainSecret(body.apiKey);
  } else {
    return apiError('INVALID_REQUEST', 400, 'apiKey 必须是字符串');
  }

  // Extra credentials follow the same tri-state per field: absent keeps the
  // stored cipher, empty string clears it, a value encrypts.
  const extraCiphers: Record<string, string> = { ...(existing.rows[0]?.extra_secrets ?? {}) };
  if (body.extraSecrets !== undefined) {
    if (typeof body.extraSecrets !== 'object' || body.extraSecrets === null) {
      return apiError('INVALID_REQUEST', 400, 'extraSecrets 必须是对象');
    }
    for (const [field, value] of Object.entries(body.extraSecrets as Record<string, unknown>)) {
      if (!(EXTRA_SECRET_FIELDS as readonly string[]).includes(field)) {
        return apiError('INVALID_REQUEST', 400, `extraSecrets 不支持字段 ${field}`);
      }
      if (typeof value !== 'string') {
        return apiError('INVALID_REQUEST', 400, 'extraSecrets 的值必须是字符串');
      }
      if (value === '') delete extraCiphers[field];
      else
        extraCiphers[field] = isAdminSecretConfigured()
          ? encryptSecret(value)
          : markPlainSecret(value);
    }
  }
  const extraSecretsJson =
    Object.keys(extraCiphers).length > 0 ? JSON.stringify(extraCiphers) : null;

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() || null : null;
  const proxy = typeof body.proxy === 'string' ? body.proxy.trim() || null : null;
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  await pool.query(
    `INSERT INTO provider_configs
       (capability, provider_id, api_key_cipher, extra_secrets, base_url, models, proxy, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (capability, provider_id) DO UPDATE SET
       api_key_cipher = EXCLUDED.api_key_cipher,
       extra_secrets = EXCLUDED.extra_secrets,
       base_url = EXCLUDED.base_url,
       models = EXCLUDED.models,
       proxy = EXCLUDED.proxy,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      cap,
      providerId,
      apiKeyCipher,
      extraSecretsJson,
      baseUrl,
      JSON.stringify(models ?? []),
      proxy,
      enabled,
      guard.session.userId,
    ],
  );

  patchProviderConfigRow(
    {
      capability: cap,
      providerId,
      apiKeyCipher,
      extraSecrets: extraSecretsJson ? extraCiphers : null,
      baseUrl,
      models: models ?? [],
      proxy,
      enabled,
      updatedBy: guard.session.userId,
      updatedAt: new Date().toISOString(),
    },
    { capability: cap, providerId },
  );

  await recordAudit(guard.session, {
    action: 'provider.upsert',
    targetType: 'provider_config',
    targetId: `${cap}:${providerId}`,
    detail: { enabled, models: models ?? [], hasApiKey: !!apiKeyCipher, baseUrl },
    ip: requestIp(request),
  });

  return Response.json({
    success: true,
    warning: isAdminSecretConfigured()
      ? undefined
      : '未设置 OPENMAIC_ADMIN_SECRET，API Key 以明文标记存储（仅限本地开发）',
  });
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const capability = url.searchParams.get('capability') ?? '';
  const providerId = (url.searchParams.get('providerId') ?? '').trim();
  if (!(ADMIN_CAPABILITIES as readonly string[]).includes(capability) || !providerId) {
    return apiError('INVALID_REQUEST', 400, '需要 capability 与 providerId 查询参数');
  }

  const pool = await getAdminPool();
  const result = await pool.query(
    'DELETE FROM provider_configs WHERE capability = $1 AND provider_id = $2',
    [capability, providerId],
  );
  if (result.rowCount === 0) {
    return apiError('INVALID_REQUEST', 404, '该配置不存在');
  }
  patchProviderConfigRow(null, {
    capability: capability as AdminCapability,
    providerId,
  });

  await recordAudit(guard.session, {
    action: 'provider.delete',
    targetType: 'provider_config',
    targetId: `${capability}:${providerId}`,
    ip: requestIp(request),
  });
  return new NextResponse(null, { status: 204 });
}
