/**
 * generation_trace sink + read models.
 *
 * The pool is doubled at the admin-db boundary so the suite asserts exactly
 * what hits PostgreSQL: INSERT parameter order/null coercion, the once-per-6h
 * prune window, and the snake_case/decimal-string → camelCase/number mapping
 * the admin drill-down consumes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getAdminPool: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

vi.mock('@/lib/admin/db', () => ({
  getAdminPool: mocks.getAdminPool,
  isDatabaseConfigured: mocks.isDatabaseConfigured,
}));

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const countDeletes = () =>
  mocks.query.mock.calls.filter(([sql]) => String(sql).includes('DELETE')).length;

describe('generation-trace-db', () => {
  beforeEach(async () => {
    // Module state (lastPruneAt, failure throttle) resets with the module.
    vi.resetModules();
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    mocks.getAdminPool.mockReset().mockResolvedValue({ query: mocks.query });
    mocks.isDatabaseConfigured.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordGenerationTraceRow', () => {
    it('inserts all 11 columns in order, coercing missing fields to null', async () => {
      const { recordGenerationTraceRow } = await import('@/lib/admin/generation-trace-db');
      await recordGenerationTraceRow({ step: 'tts', durationMs: 123, status: 'ok' });

      // The first write of a fresh module also fires the opportunistic prune
      // (lastPruneAt starts at 0) — that window is pinned by its own test below.
      const [sql, params] = mocks.query.mock.calls.find(([candidate]) =>
        String(candidate).includes('INSERT INTO generation_trace'),
      ) as [string, unknown[]];
      expect(sql).toContain('INSERT INTO generation_trace');
      expect(params).toEqual([null, null, 'tts', null, null, null, 123, 'ok', null, null, null]);
    });

    it('passes every populated field through', async () => {
      const { recordGenerationTraceRow } = await import('@/lib/admin/generation-trace-db');
      await recordGenerationTraceRow({
        step: 'scene-content',
        stageId: 'stage-1',
        ownerId: 'user:u1',
        page: 3,
        providerId: 'openai',
        modelId: 'gpt-test',
        durationMs: 4567,
        status: 'error',
        httpStatus: 500,
        errorCode: 'UPSTREAM_ERROR',
        errorSnippet: 'upstream dropped connection',
      });

      const [, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([
        'stage-1',
        'user:u1',
        'scene-content',
        3,
        'openai',
        'gpt-test',
        4567,
        'error',
        500,
        'UPSTREAM_ERROR',
        'upstream dropped connection',
      ]);
    });

    it('prunes at most once per 6h window, then again after it elapses', async () => {
      const { recordGenerationTraceRow } = await import('@/lib/admin/generation-trace-db');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000);

      await recordGenerationTraceRow({ step: 'tts', durationMs: 1, status: 'ok' });
      // lastPruneAt starts at 0, so the first write prunes.
      expect(countDeletes()).toBe(1);

      await recordGenerationTraceRow({ step: 'tts', durationMs: 1, status: 'ok' });
      expect(countDeletes()).toBe(1);

      nowSpy.mockReturnValue(1_000_000_000 + PRUNE_INTERVAL_MS + 1);
      await recordGenerationTraceRow({ step: 'tts', durationMs: 1, status: 'ok' });
      expect(countDeletes()).toBe(2);
      expect(nowSpy).toHaveBeenCalled();
    });

    it('swallows write failures instead of throwing', async () => {
      const { recordGenerationTraceRow } = await import('@/lib/admin/generation-trace-db');
      mocks.query.mockRejectedValue(new Error('connection refused'));
      await expect(
        recordGenerationTraceRow({ step: 'tts', durationMs: 1, status: 'ok' }),
      ).resolves.toBeUndefined();
    });

    it('is a no-op when the database is not configured', async () => {
      mocks.isDatabaseConfigured.mockReturnValue(false);
      const { recordGenerationTraceRow } = await import('@/lib/admin/generation-trace-db');
      await recordGenerationTraceRow({ step: 'tts', durationMs: 1, status: 'ok' });
      expect(mocks.query).not.toHaveBeenCalled();
    });
  });

  describe('queryGenerationTraceByStage', () => {
    it('maps snake_case rows (bigint ids as strings) to the camelCase read model', async () => {
      const createdAt = new Date('2026-09-20T01:02:03.000Z');
      mocks.query.mockResolvedValue({
        rows: [
          {
            id: '5',
            created_at: createdAt,
            stage_id: 'stage-1',
            owner_id: 'user:u1',
            step: 'tts',
            page: 3,
            provider_id: 'openai',
            model_id: 'gpt-test',
            duration_ms: 8123,
            status: 'error',
            http_status: 429,
            error_code: 'RATE_LIMITED',
            error_snippet: 'Too many requests',
          },
        ],
      });

      const { queryGenerationTraceByStage } = await import('@/lib/admin/generation-trace-db');
      const rows = await queryGenerationTraceByStage('stage-1');

      expect(rows).toEqual([
        {
          id: 5,
          createdAt: '2026-09-20T01:02:03.000Z',
          stageId: 'stage-1',
          ownerId: 'user:u1',
          step: 'tts',
          page: 3,
          providerId: 'openai',
          modelId: 'gpt-test',
          durationMs: 8123,
          status: 'error',
          httpStatus: 429,
          errorCode: 'RATE_LIMITED',
          errorSnippet: 'Too many requests',
        },
      ]);
      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(params).toEqual(['stage-1', 500]);
    });
  });

  describe('queryGenerationTraceSummary', () => {
    it('aggregates per-step string aggregates into numbers and totals', async () => {
      const first = new Date('2026-09-20T00:00:00.000Z');
      const last = new Date('2026-09-20T00:10:00.000Z');
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('GROUP BY')) {
          return {
            rows: [
              { step: 'tts', calls: '4', errors: '1', avg_ms: '1000', total_ms: '4000' },
              { step: 'scene-content', calls: '2', errors: '0', avg_ms: '3000', total_ms: '6000' },
            ],
          };
        }
        return { rows: [{ first, last }] };
      });

      const { queryGenerationTraceSummary } = await import('@/lib/admin/generation-trace-db');
      const summary = await queryGenerationTraceSummary('stage-1');

      expect(summary).toEqual({
        steps: [
          { step: 'tts', calls: 4, errors: 1, avgMs: 1000, totalMs: 4000 },
          { step: 'scene-content', calls: 2, errors: 0, avgMs: 3000, totalMs: 6000 },
        ],
        totalCalls: 6,
        totalErrors: 1,
        firstCallAt: '2026-09-20T00:00:00.000Z',
        lastCallAt: '2026-09-20T00:10:00.000Z',
      });
    });

    it('returns zeroed totals and null span for a course with no rows', async () => {
      mocks.query.mockImplementation(async (sql: string) =>
        sql.includes('GROUP BY') ? { rows: [] } : { rows: [{ first: null, last: null }] },
      );

      const { queryGenerationTraceSummary } = await import('@/lib/admin/generation-trace-db');
      const summary = await queryGenerationTraceSummary('stage-empty');

      expect(summary).toEqual({
        steps: [],
        totalCalls: 0,
        totalErrors: 0,
        firstCallAt: null,
        lastCallAt: null,
      });
    });
  });
});
