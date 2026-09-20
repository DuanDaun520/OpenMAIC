/**
 * /api/admin/providers/import — the console's env/YAML → `provider_configs`
 * import.
 *
 * Everything with a side effect is doubled (auth, pool, persist, audit, config
 * loading); the row-derivation table lives in
 * tests/server/provider-config-import.test.ts and the upsert/encrypt/overlay
 * write path in tests/server/provider-config-persist.test.ts. What is pinned
 * here: admin gate first, dry-run returns a masked plan without writing, the
 * default write skips existing rows while force overwrites, and the import
 * lands in the audit log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/admin/providers/import/route';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminPool: vi.fn(),
  recordAudit: vi.fn(),
  requestIp: vi.fn(),
  isAdminSecretConfigured: vi.fn(),
  persistProviderConfigRow: vi.fn(),
  loadEnvYamlServerConfig: vi.fn(),
  buildProviderConfigImportRows: vi.fn(),
}));

vi.mock('@/lib/admin/auth', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/admin/db', () => ({ getAdminPool: mocks.getAdminPool }));
vi.mock('@/lib/admin/audit', () => ({
  recordAudit: mocks.recordAudit,
  requestIp: mocks.requestIp,
}));
vi.mock('@/lib/admin/crypto', () => ({
  isAdminSecretConfigured: mocks.isAdminSecretConfigured,
}));
vi.mock('@/lib/server/provider-config-persist', () => ({
  persistProviderConfigRow: mocks.persistProviderConfigRow,
}));
vi.mock('@/lib/server/provider-config', () => ({
  loadEnvYamlServerConfig: mocks.loadEnvYamlServerConfig,
}));
vi.mock('@/lib/server/provider-config-import', () => ({
  buildProviderConfigImportRows: mocks.buildProviderConfigImportRows,
}));

const pool = vi.hoisted(() => ({ query: vi.fn() }));

/**
 * Two-file world: llm/openai already imported (skip by default);
 * pdf/alidocmind — an AK/SK provider — not yet.
 */
const PLANNED_ROWS = [
  {
    capability: 'llm',
    providerId: 'openai',
    apiKey: 'sk-test-1234',
    extraSecrets: {},
    baseUrl: null,
    models: ['gpt-5'],
    proxy: null,
    enabled: true,
  },
  {
    capability: 'pdf',
    providerId: 'alidocmind',
    apiKey: '',
    extraSecrets: { accessKeyId: 'ak-1', accessKeySecret: 'sk-1' },
    baseUrl: 'https://docmind.example',
    models: [],
    proxy: null,
    enabled: true,
  },
];

function importRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/admin/providers/import', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('/api/admin/providers/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { userId: 'u-admin' } });
    mocks.requestIp.mockReturnValue('127.0.0.1');
    mocks.isAdminSecretConfigured.mockReturnValue(true);
    mocks.loadEnvYamlServerConfig.mockReturnValue({ pdf: {} });
    mocks.buildProviderConfigImportRows.mockReturnValue(PLANNED_ROWS);
    mocks.getAdminPool.mockResolvedValue(pool);
    // Any SELECT returns the existing-row set; other results are ignored.
    pool.query.mockResolvedValue({
      rows: [
        { capability: 'llm', provider_id: 'openai' },
        { capability: 'pdf', provider_id: 'alidocmind' },
      ],
    });
  });

  it('returns the guard response when the caller is not an admin', async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response('unauthorized', { status: 401 }),
    });

    const response = await POST(importRequest({}));

    expect(response.status).toBe(401);
    expect(mocks.getAdminPool).not.toHaveBeenCalled();
    expect(mocks.persistProviderConfigRow).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('dry-run returns a masked plan with counts and never writes', async () => {
    const response = await POST(importRequest({ dryRun: true }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dryRun).toBe(true);
    expect(body.counts).toEqual({ total: 2, toImport: 0, skipped: 2 });
    expect(body.plan).toEqual([
      expect.objectContaining({
        capability: 'llm',
        providerId: 'openai',
        apiKeyTail: '••••1234',
        extraSecretFields: [],
        willSkip: true,
      }),
      expect.objectContaining({
        capability: 'pdf',
        providerId: 'alidocmind',
        apiKeyTail: null,
        extraSecretFields: ['accessKeyId', 'accessKeySecret'],
        willSkip: true,
      }),
    ]);
    // Masked tail only — the plaintext key must never leave the process.
    expect(JSON.stringify(body)).not.toContain('sk-test-1234');
    expect(mocks.persistProviderConfigRow).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('warns when the admin secret is not configured', async () => {
    mocks.isAdminSecretConfigured.mockReturnValue(false);

    const response = await POST(importRequest({ dryRun: true }));
    const body = await response.json();

    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('OPENMAIC_ADMIN_SECRET');
  });

  it('writes only missing rows by default, with admin attribution, and audits', async () => {
    // Fresh database: nothing exists, both rows import.
    pool.query.mockResolvedValue({ rows: [] });

    const response = await POST(importRequest({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      imported: 2,
      skipped: 0,
      warnings: [],
    });

    expect(mocks.persistProviderConfigRow).toHaveBeenCalledTimes(2);
    expect(mocks.persistProviderConfigRow).toHaveBeenCalledWith(PLANNED_ROWS[0], 'u-admin');
    expect(mocks.persistProviderConfigRow).toHaveBeenCalledWith(PLANNED_ROWS[1], 'u-admin');

    expect(mocks.recordAudit).toHaveBeenCalledWith(
      { userId: 'u-admin' },
      {
        action: 'provider.import',
        targetType: 'provider_config',
        targetId: 'env-yaml',
        detail: { imported: 2, skipped: 0, force: false },
        ip: '127.0.0.1',
      },
    );
  });

  it('force overwrites existing rows', async () => {
    // Default fixture: both rows already exist; force must import them anyway.
    const response = await POST(importRequest({ force: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ imported: 2, skipped: 0 });
    expect(mocks.persistProviderConfigRow).toHaveBeenCalledTimes(2);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      { userId: 'u-admin' },
      expect.objectContaining({ detail: { imported: 2, skipped: 0, force: true } }),
    );
  });

  it('answers 405 on GET — the route is POST-only', async () => {
    const response = GET();
    expect(response.status).toBe(405);
  });
});
