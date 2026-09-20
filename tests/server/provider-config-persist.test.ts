/**
 * lib/server/provider-config-persist — the shared write path for
 * config-in-database: upsert + encrypt + write-through overlay patch, and the
 * one-time first-boot seed that migrates env/YAML into `provider_configs`.
 *
 * Pool, crypto, audit, overlay and config loading are doubled. What is pinned
 * here: secrets are encrypted (or plain-marked) before touching the DB, an
 * empty extra-secrets map stores NULL, and the seed runs exactly once — only
 * when the table is empty and the admin secret is configured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAdminPool: vi.fn(),
  recordAudit: vi.fn(),
  encryptSecret: vi.fn(),
  markPlainSecret: vi.fn(),
  isAdminSecretConfigured: vi.fn(),
  loadProviderConfigRows: vi.fn(),
  patchProviderConfigRow: vi.fn(),
  loadEnvYamlServerConfig: vi.fn(),
  buildProviderConfigImportRows: vi.fn(),
}));

vi.mock('@/lib/admin/db', () => ({ getAdminPool: mocks.getAdminPool }));
vi.mock('@/lib/admin/audit', () => ({ recordAudit: mocks.recordAudit }));
vi.mock('@/lib/admin/crypto', () => ({
  encryptSecret: mocks.encryptSecret,
  markPlainSecret: mocks.markPlainSecret,
  isAdminSecretConfigured: mocks.isAdminSecretConfigured,
}));
vi.mock('@/lib/admin/provider-overrides', () => ({
  loadProviderConfigRows: mocks.loadProviderConfigRows,
  patchProviderConfigRow: mocks.patchProviderConfigRow,
}));
vi.mock('@/lib/server/provider-config', () => ({
  loadEnvYamlServerConfig: mocks.loadEnvYamlServerConfig,
}));
vi.mock('@/lib/server/provider-config-import', () => ({
  buildProviderConfigImportRows: mocks.buildProviderConfigImportRows,
}));

const pool = vi.hoisted(() => ({ query: vi.fn() }));

const ALIDOCMIND_ROW = {
  capability: 'pdf' as const,
  providerId: 'alidocmind',
  apiKey: '',
  extraSecrets: { accessKeyId: 'ak-1', accessKeySecret: 'sk-1' },
  baseUrl: 'https://docmind.example',
  models: [],
  proxy: null,
  enabled: true,
};

/** Fresh module per test — maybeSeedProviderConfigs is once-per-process. */
async function importPersist() {
  return await import('@/lib/server/provider-config-persist');
}

describe('persistProviderConfigRow', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getAdminPool.mockResolvedValue(pool);
    pool.query.mockResolvedValue({ rows: [] });
    mocks.encryptSecret.mockImplementation((plain: string) => `enc:${plain}`);
    mocks.markPlainSecret.mockImplementation((plain: string) => `plain:${plain}`);
  });

  it('encrypts the API key and extra secrets, then write-through patches', async () => {
    mocks.isAdminSecretConfigured.mockReturnValue(true);
    const { persistProviderConfigRow } = await importPersist();

    await persistProviderConfigRow({ ...ALIDOCMIND_ROW, apiKey: 'sk-9' }, 'u-admin');

    expect(mocks.encryptSecret).toHaveBeenCalledWith('sk-9');
    expect(mocks.encryptSecret).toHaveBeenCalledWith('ak-1');
    expect(mocks.encryptSecret).toHaveBeenCalledWith('sk-1');
    expect(mocks.markPlainSecret).not.toHaveBeenCalled();

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('extra_secrets = EXCLUDED.extra_secrets');
    expect(params).toEqual([
      'pdf',
      'alidocmind',
      'enc:sk-9',
      JSON.stringify({ accessKeyId: 'enc:ak-1', accessKeySecret: 'enc:sk-1' }),
      'https://docmind.example',
      '[]',
      null,
      true,
      'u-admin',
    ]);

    expect(mocks.patchProviderConfigRow).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyCipher: 'enc:sk-9',
        extraSecrets: { accessKeyId: 'enc:ak-1', accessKeySecret: 'enc:sk-1' },
        updatedBy: 'u-admin',
      }),
      { capability: 'pdf', providerId: 'alidocmind' },
    );
  });

  it('plain-marks when the admin secret is unset (local dev)', async () => {
    mocks.isAdminSecretConfigured.mockReturnValue(false);
    const { persistProviderConfigRow } = await importPersist();

    await persistProviderConfigRow({ ...ALIDOCMIND_ROW, apiKey: 'sk-9' }, null);

    expect(mocks.markPlainSecret).toHaveBeenCalledWith('sk-9');
    expect(mocks.encryptSecret).not.toHaveBeenCalled();
    const [, params] = pool.query.mock.calls[0];
    expect(params[2]).toBe('plain:sk-9');
  });

  it('stores NULL extra_secrets when the map is empty and no key is set', async () => {
    mocks.isAdminSecretConfigured.mockReturnValue(true);
    const { persistProviderConfigRow } = await importPersist();

    await persistProviderConfigRow(
      {
        capability: 'llm',
        providerId: 'ollama',
        apiKey: '',
        baseUrl: 'http://localhost:11434/v1',
        models: ['qwen3'],
        proxy: null,
        enabled: true,
      },
      null,
    );

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO provider_configs');
    expect(params[2]).toBeNull(); // api_key_cipher
    expect(params[3]).toBeNull(); // extra_secrets
    expect(mocks.patchProviderConfigRow).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyCipher: null, extraSecrets: null }),
      { capability: 'llm', providerId: 'ollama' },
    );
  });
});

describe('maybeSeedProviderConfigs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getAdminPool.mockResolvedValue(pool);
    pool.query.mockResolvedValue({ rows: [] });
    mocks.encryptSecret.mockImplementation((plain: string) => `enc:${plain}`);
    mocks.isAdminSecretConfigured.mockReturnValue(true);
    mocks.loadEnvYamlServerConfig.mockReturnValue({ pdf: {} });
    mocks.buildProviderConfigImportRows.mockReturnValue([ALIDOCMIND_ROW]);
  });

  it('seeds all rows with system attribution when the table is empty', async () => {
    mocks.loadProviderConfigRows.mockResolvedValue([]);
    const { maybeSeedProviderConfigs } = await importPersist();

    await maybeSeedProviderConfigs();

    expect(mocks.patchProviderConfigRow).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      { userId: null, username: 'system' },
      {
        action: 'provider.autoseed',
        targetType: 'provider_config',
        targetId: 'env-yaml',
        detail: { imported: 1 },
      },
    );
    // System write: updated_by NULL, not an admin id.
    const [, params] = pool.query.mock.calls[0];
    expect(params[8]).toBeNull();
  });

  it('leaves a non-empty table alone', async () => {
    mocks.loadProviderConfigRows.mockResolvedValue([{ capability: 'llm', providerId: 'openai' }]);
    const { maybeSeedProviderConfigs } = await importPersist();

    await maybeSeedProviderConfigs();

    expect(mocks.patchProviderConfigRow).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('never auto-writes plaintext-marked keys (secret unset)', async () => {
    mocks.isAdminSecretConfigured.mockReturnValue(false);
    mocks.loadProviderConfigRows.mockResolvedValue([]);
    const { maybeSeedProviderConfigs } = await importPersist();

    await maybeSeedProviderConfigs();

    expect(mocks.patchProviderConfigRow).not.toHaveBeenCalled();
  });

  it('does nothing when env/YAML hold no provider config', async () => {
    mocks.loadProviderConfigRows.mockResolvedValue([]);
    mocks.buildProviderConfigImportRows.mockReturnValue([]);
    const { maybeSeedProviderConfigs } = await importPersist();

    await maybeSeedProviderConfigs();

    expect(mocks.patchProviderConfigRow).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('attempts at most once per process', async () => {
    mocks.loadProviderConfigRows.mockResolvedValue([]);
    const { maybeSeedProviderConfigs } = await importPersist();

    await maybeSeedProviderConfigs();
    await maybeSeedProviderConfigs();

    expect(mocks.patchProviderConfigRow).toHaveBeenCalledTimes(1);
  });

  it('a failure logs and does not throw', async () => {
    mocks.loadProviderConfigRows.mockRejectedValue(new Error('db down'));
    const { maybeSeedProviderConfigs } = await importPersist();

    await expect(maybeSeedProviderConfigs()).resolves.toBeUndefined();
  });
});
