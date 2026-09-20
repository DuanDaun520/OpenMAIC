/**
 * Write path for DB-first provider configuration, shared by the admin API
 * (POST /api/admin/providers/import) and the one-time bootstrap seed that
 * migrates an env/YAML-configured deployment into `provider_configs` on
 * first boot — after which the admin console is the operational home and the
 * files remain only as a break-glass fallback.
 *
 * This runs inside the server process on purpose: the app's module graph
 * assumes a bundler context, so a standalone Node script cannot load the
 * config-loading code (see the import route's header comment).
 */
import { recordAudit } from '@/lib/admin/audit';
import { encryptSecret, isAdminSecretConfigured, markPlainSecret } from '@/lib/admin/crypto';
import { getAdminPool } from '@/lib/admin/db';
import {
  type AdminCapability,
  loadProviderConfigRows,
  patchProviderConfigRow,
} from '@/lib/admin/provider-overrides';
import { loadEnvYamlServerConfig } from '@/lib/server/provider-config';
import { buildProviderConfigImportRows } from '@/lib/server/provider-config-import';

/** A row to persist. Secrets arrive in plaintext and are encrypted here. */
export interface ProviderConfigWrite {
  capability: AdminCapability;
  providerId: string;
  apiKey: string;
  /** Extra credentials (AliDocMind AccessKey pair), field → plaintext. */
  extraSecrets?: Record<string, string>;
  baseUrl: string | null;
  models: string[];
  proxy: string | null;
  enabled: boolean;
}

function cipherFor(plaintext: string): string {
  return isAdminSecretConfigured() ? encryptSecret(plaintext) : markPlainSecret(plaintext);
}

/**
 * Upsert one row, then write-through the in-memory overlay so this process
 * serves the new config on the next request (others converge on the TTL
 * refresh). `updatedBy` is the acting admin's id, or null for system writes
 * (the bootstrap seed).
 */
export async function persistProviderConfigRow(
  row: ProviderConfigWrite,
  updatedBy: string | null,
): Promise<void> {
  const apiKeyCipher = row.apiKey ? cipherFor(row.apiKey) : null;
  const extraCiphers: Record<string, string> = {};
  for (const [field, plaintext] of Object.entries(row.extraSecrets ?? {})) {
    if (plaintext) extraCiphers[field] = cipherFor(plaintext);
  }

  const pool = await getAdminPool();
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
      row.capability,
      row.providerId,
      apiKeyCipher,
      Object.keys(extraCiphers).length > 0 ? JSON.stringify(extraCiphers) : null,
      row.baseUrl,
      JSON.stringify(row.models),
      row.proxy,
      row.enabled,
      updatedBy,
    ],
  );

  patchProviderConfigRow(
    {
      capability: row.capability,
      providerId: row.providerId,
      apiKeyCipher,
      extraSecrets: Object.keys(extraCiphers).length > 0 ? extraCiphers : null,
      baseUrl: row.baseUrl,
      models: row.models,
      proxy: row.proxy,
      enabled: row.enabled,
      updatedBy,
      updatedAt: new Date().toISOString(),
    },
    { capability: row.capability, providerId: row.providerId },
  );
}

let seedAttempted = false;

/**
 * One-time bootstrap: when `provider_configs` is empty but env/YAML still
 * configures providers, import those rows so the console becomes the single
 * configuration surface on first boot. Triggered from the overlay loader
 * whenever it observes an empty table; idempotent (one attempt per process,
 * and a non-empty table is left alone).
 *
 * Skipped unless OPENMAIC_ADMIN_SECRET is set — auto-writing plaintext-marked
 * keys into a shared database is never the right default; a secret-less
 * deployment can still import explicitly from the console (which warns).
 * Failures log and leave env/YAML serving as before.
 */
export async function maybeSeedProviderConfigs(): Promise<void> {
  if (seedAttempted) return;
  seedAttempted = true;
  try {
    if (!isAdminSecretConfigured()) return;
    if ((await loadProviderConfigRows()).length > 0) return;
    const rows = buildProviderConfigImportRows(loadEnvYamlServerConfig());
    if (rows.length === 0) return;
    for (const row of rows) {
      await persistProviderConfigRow(row, null);
    }
    await recordAudit(
      { userId: null, username: 'system' },
      {
        action: 'provider.autoseed',
        targetType: 'provider_config',
        targetId: 'env-yaml',
        detail: { imported: rows.length },
      },
    );
    console.info(
      `[admin] provider_configs was empty — seeded ${rows.length} rows from env/YAML; ` +
        'the admin console now owns provider configuration',
    );
  } catch (error) {
    console.error('[admin] provider-config bootstrap seed failed', error);
  }
}
