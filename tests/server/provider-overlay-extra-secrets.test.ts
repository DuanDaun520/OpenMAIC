/**
 * applyAdminProviderOverlay × extra_secrets — the DB-first config path for
 * AliDocMind's AccessKey pair.
 *
 * The overlay snapshot is installed directly via patchProviderConfigRow (with
 * `plain:` marker ciphers, so no admin secret is needed); what is pinned: a
 * pdf:alidocmind row injects decrypted AK/SK into the effective config, and an
 * `enabled: false` pdf row means unmanaged (no server-side credentials).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs — only intercept server-providers.yml; delegate everything else.
let yamlOverride: string | null = null;
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
      readFileSync: (p: string, ...args: unknown[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
    },
    existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
    readFileSync: (p: string, ...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
  };
});

// No database in this unit: the background overlay refresh never settles, so
// it cannot overwrite the snapshot installed by patchProviderConfigRow.
vi.mock('@/lib/admin/db', () => ({
  getAdminPool: vi.fn(() => new Promise(() => {})),
}));

function clearAliDocMindEnv() {
  delete process.env.ALIDOCMIND_ACCESS_KEY_ID;
  delete process.env.ALIDOCMIND_ACCESS_KEY_SECRET;
  delete process.env.ALIDOCMIND_BASE_URL;
}

async function importModules() {
  const providerConfig = await import('@/lib/server/provider-config');
  const overrides = await import('@/lib/admin/provider-overrides');
  return { providerConfig, overrides };
}

describe('overlay extra_secrets (AliDocMind AK/SK)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearAliDocMindEnv();
    yamlOverride = null;
  });

  it('a DB row injects decrypted AK/SK into the effective pdf config', async () => {
    const { providerConfig, overrides } = await importModules();

    overrides.patchProviderConfigRow(
      {
        capability: 'pdf',
        providerId: 'alidocmind',
        apiKeyCipher: null,
        extraSecrets: { accessKeyId: 'plain:ak-1', accessKeySecret: 'plain:sk-1' },
        baseUrl: 'https://docmind.example',
        models: [],
        proxy: null,
        enabled: true,
        updatedBy: null,
        updatedAt: new Date().toISOString(),
      },
      { capability: 'pdf', providerId: 'alidocmind' },
    );

    // No env/yaml source involved — the DB row alone makes the provider
    // server-managed with usable credentials.
    expect(providerConfig.resolveManagedAliDocMindCredentials()).toEqual({
      accessKeyId: 'ak-1',
      accessKeySecret: 'sk-1',
      baseUrl: 'https://docmind.example',
    });
  });

  it('an enabled:false pdf row leaves the provider unmanaged', async () => {
    const { providerConfig, overrides } = await importModules();

    overrides.patchProviderConfigRow(
      {
        capability: 'pdf',
        providerId: 'alidocmind',
        apiKeyCipher: null,
        extraSecrets: { accessKeyId: 'plain:ak-1', accessKeySecret: 'plain:sk-1' },
        baseUrl: null,
        models: [],
        proxy: null,
        enabled: false,
        updatedBy: null,
        updatedAt: new Date().toISOString(),
      },
      { capability: 'pdf', providerId: 'alidocmind' },
    );

    // enabled:false on llm/pdf = "unmanaged" — clients supply their own creds.
    expect(providerConfig.resolveManagedAliDocMindCredentials()).toBeUndefined();
  });
});
