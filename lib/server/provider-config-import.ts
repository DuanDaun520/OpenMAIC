/**
 * env/YAML → `provider_configs` row derivation for the config-in-database
 * import (POST /api/admin/providers/import).
 *
 * Pure on purpose: the decision table — the section→capability mapping, the
 * operator force-disable sets becoming `enabled: false` rows, deterministic
 * ordering — is pinned by unit tests with no database and no filesystem. The
 * route owns everything with side effects (connecting, encrypting, writing).
 *
 * Row semantics mirror `applyAdminProviderOverlay` exactly, so a config that
 * behaved one way from env/YAML behaves the same way from the imported rows:
 *
 * - A configured entry imports as `enabled: true` — except entries the
 *   operator force-disabled (yml `enabled: false` / `<CAP>_<PREFIX>_ENABLED`
 *   env), which import as `enabled: false` rows the overlay re-applies to the
 *   disabled set.
 * - LLM and PDF rows are always `enabled: true`: those sections have no
 *   force-disable concept, and an `enabled: false` row there would mean
 *   "unmanaged" (clients fall back to their own keys) — the opposite of a
 *   configured provider.
 * - A force-disable with no credentials never produces a section entry (the
 *   loader activates on key/baseUrl), but the disable itself must survive the
 *   config file's removal — so bare `enabled: false` rows are emitted for it.
 * - AliDocMind's AccessKey pair rides the row's `extraSecrets` map (stored in
 *   the `extra_secrets` column, encrypted like the API key) — the import
 *   covers the provider completely, no env residue.
 */
import type { AdminCapability } from '@/lib/admin/provider-overrides';
import {
  SECTION_TO_ADMIN_CAPABILITY,
  type ProviderSection,
  type ServerConfig,
} from '@/lib/server/provider-config';

/** One planned `provider_configs` row, before the secrets are encrypted. */
export interface ProviderConfigImportRow {
  capability: AdminCapability;
  providerId: string;
  /** Plaintext — the caller encrypts (or plain-marks) at write time. */
  apiKey: string;
  /**
   * Extra credentials that don't fit the single api_key column (AliDocMind's
   * AccessKey pair), field → plaintext. Empty for most providers.
   */
  extraSecrets: Record<string, string>;
  baseUrl: string | null;
  models: string[];
  proxy: string | null;
  enabled: boolean;
}

/** Entry fields carried into the `extra_secrets` column. */
const EXTRA_SECRET_FIELDS = ['accessKeyId', 'accessKeySecret'] as const;

export function buildProviderConfigImportRows(config: ServerConfig): ProviderConfigImportRow[] {
  const rows: ProviderConfigImportRow[] = [];
  for (const section of Object.keys(SECTION_TO_ADMIN_CAPABILITY) as ProviderSection[]) {
    const capability = SECTION_TO_ADMIN_CAPABILITY[section];
    // Only the capability sections carry a force-disable set; `providers` and
    // `pdf` are absent from it, which the optional access expresses.
    const disabled = (config.disabled as Record<string, Set<string> | undefined>)[section];
    for (const [providerId, entry] of Object.entries(config[section])) {
      const extraSecrets: Record<string, string> = {};
      for (const field of EXTRA_SECRET_FIELDS) {
        const value = entry[field];
        if (value) extraSecrets[field] = value;
      }
      rows.push({
        capability,
        providerId,
        apiKey: entry.apiKey || '',
        extraSecrets,
        baseUrl: entry.baseUrl ?? null,
        models: entry.models ?? [],
        proxy: entry.proxy ?? null,
        enabled: !disabled?.has(providerId),
      });
    }
    if (disabled) {
      for (const providerId of disabled) {
        if (!config[section][providerId]) {
          rows.push({
            capability,
            providerId,
            apiKey: '',
            extraSecrets: {},
            baseUrl: null,
            models: [],
            proxy: null,
            enabled: false,
          });
        }
      }
    }
  }
  // Deterministic output regardless of key insertion order, so dry-run plans
  // and test snapshots stay stable.
  rows.sort((a, b) =>
    a.capability === b.capability
      ? a.providerId.localeCompare(b.providerId)
      : a.capability.localeCompare(b.capability),
  );
  return rows;
}
