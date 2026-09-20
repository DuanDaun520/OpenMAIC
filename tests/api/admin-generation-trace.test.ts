/**
 * /api/admin/generation-trace — the 生成过程 drill-down's read API.
 *
 * Auth and the two DB read models are doubled; the suite pins the contract:
 * admin gate first, then DATABASE_URL availability, then stageId validation,
 * then the { success, stageId, rows, summary } response shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/admin/generation-trace/route';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  queryGenerationTraceByStage: vi.fn(),
  queryGenerationTraceSummary: vi.fn(),
}));

vi.mock('@/lib/admin/auth', () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock('@/lib/admin/generation-trace-db', () => ({
  queryGenerationTraceByStage: mocks.queryGenerationTraceByStage,
  queryGenerationTraceSummary: mocks.queryGenerationTraceSummary,
}));

function traceRequest(url = 'http://localhost:3000/api/admin/generation-trace?stageId=stage-1') {
  return new Request(url);
}

describe('/api/admin/generation-trace', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://admin-test');
    mocks.requireAdmin.mockReset().mockResolvedValue({ ok: true, session: { id: 'admin' } });
    mocks.queryGenerationTraceByStage.mockReset().mockResolvedValue([]);
    mocks.queryGenerationTraceSummary.mockReset().mockResolvedValue({
      steps: [],
      totalCalls: 0,
      totalErrors: 0,
      firstCallAt: null,
      lastCallAt: null,
    });
  });

  it('returns the guard response when the caller is not an admin', async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response('unauthorized', { status: 401 }),
    });

    const response = await GET(traceRequest());
    expect(response.status).toBe(401);
    expect(mocks.queryGenerationTraceByStage).not.toHaveBeenCalled();
  });

  it('answers 503 when DATABASE_URL is not configured', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const response = await GET(traceRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect(mocks.queryGenerationTraceByStage).not.toHaveBeenCalled();
  });

  it('rejects a missing or blank stageId with 400', async () => {
    const missing = await GET(traceRequest('http://localhost:3000/api/admin/generation-trace'));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ errorCode: 'INVALID_REQUEST' });

    const blank = await GET(
      traceRequest('http://localhost:3000/api/admin/generation-trace?stageId=%20%20'),
    );
    expect(blank.status).toBe(400);
    expect(mocks.queryGenerationTraceByStage).not.toHaveBeenCalled();
  });

  it('returns rows and a summary for the requested course', async () => {
    const rows = [
      {
        id: 5,
        createdAt: '2026-09-20T00:00:01.000Z',
        stageId: 'stage-1',
        ownerId: 'user:u1',
        step: 'tts',
        page: 1,
        providerId: 'openai-tts',
        modelId: 'tts-1',
        durationMs: 900,
        status: 'ok',
        httpStatus: 200,
        errorCode: null,
        errorSnippet: null,
      },
    ];
    const summary = {
      steps: [{ step: 'tts', calls: 1, errors: 0, avgMs: 900, totalMs: 900 }],
      totalCalls: 1,
      totalErrors: 0,
      firstCallAt: '2026-09-20T00:00:01.000Z',
      lastCallAt: '2026-09-20T00:00:01.000Z',
    };
    mocks.queryGenerationTraceByStage.mockResolvedValue(rows);
    mocks.queryGenerationTraceSummary.mockResolvedValue(summary);

    const response = await GET(traceRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      stageId: 'stage-1',
      rows,
      summary,
    });
    expect(mocks.queryGenerationTraceByStage).toHaveBeenCalledWith('stage-1');
    expect(mocks.queryGenerationTraceSummary).toHaveBeenCalledWith('stage-1');
  });
});
