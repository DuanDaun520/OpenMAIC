/**
 * withGenerationTrace — the generation-route wrapper that turns every HTTP
 * call (successes, validation 400s, quota 429s, thrown errors) into one
 * generation_trace row.
 *
 * The suite lifts the emit guards vitest normally relies on (VITEST /
 * NODE_ENV=test / empty DATABASE_URL all no-op in production code paths), so
 * each test re-stubs a production-like environment and restores it after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { withGenerationTrace } from '@/lib/server/generation-trace';

const mocks = vi.hoisted(() => ({
  recordGenerationTraceRow: vi.fn(),
  readAuthAwareOwnerId: vi.fn(),
}));

vi.mock('@/lib/admin/generation-trace-db', () => ({
  recordGenerationTraceRow: mocks.recordGenerationTraceRow,
}));

vi.mock('@/lib/server/agent-runtime/auth-owner', () => ({
  readAuthAwareOwnerId: mocks.readAuthAwareOwnerId,
}));

/** A Request-shaped object is all the wrapper needs (Pick<Request,'headers'>). */
const fakeRequest = () => ({ headers: new Headers() });

/** Flush the fire-and-forget emit until the sink spy has been called `n` times. */
async function waitForRows(n: number) {
  await vi.waitFor(() => expect(mocks.recordGenerationTraceRow).toHaveBeenCalledTimes(n));
}

describe('withGenerationTrace', () => {
  beforeEach(() => {
    // Production-like guards: no VITEST, NODE_ENV != test, DATABASE_URL set.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'postgres://trace-test');
    mocks.recordGenerationTraceRow.mockReset().mockResolvedValue(undefined);
    mocks.readAuthAwareOwnerId.mockReset().mockResolvedValue('user:u1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records an ok row with the fields the handler filled in', async () => {
    const response = await withGenerationTrace(fakeRequest(), 'scene-content', async (trace) => {
      trace.stageId = 'stage-1';
      trace.page = 2;
      trace.providerId = 'openai';
      trace.modelId = 'gpt-test';
      await trace.ownerId;
      return NextResponse.json({ success: true });
    });

    expect(response.status).toBe(200);
    await waitForRows(1);
    expect(mocks.recordGenerationTraceRow).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'scene-content',
        stageId: 'stage-1',
        ownerId: 'user:u1',
        page: 2,
        providerId: 'openai',
        modelId: 'gpt-test',
        durationMs: expect.any(Number),
        status: 'ok',
        httpStatus: 200,
      }),
    );
    const row = mocks.recordGenerationTraceRow.mock.calls[0][0] as { durationMs: number };
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records apiError rows with errorCode and a snippet from details, without consuming the body', async () => {
    const response = await withGenerationTrace(fakeRequest(), 'tts', async () =>
      apiError('RATE_LIMITED', 429, 'Too many requests', 'x'.repeat(400)),
    );

    expect(response.status).toBe(429);
    // The client still receives the untouched body — the wrapper reads a clone.
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'RATE_LIMITED' });

    await waitForRows(1);
    const row = mocks.recordGenerationTraceRow.mock.calls[0][0] as {
      status: string;
      httpStatus: number;
      errorCode: string;
      errorSnippet: string;
    };
    expect(row.status).toBe('error');
    expect(row.httpStatus).toBe(429);
    expect(row.errorCode).toBe('RATE_LIMITED');
    // 300 chars + the ellipsis.
    expect(row.errorSnippet).toBe('x'.repeat(300) + '…');
  });

  it('records a thrown handler error and rethrows it', async () => {
    await expect(
      withGenerationTrace(fakeRequest(), 'image', async (trace) => {
        trace.stageId = 'stage-throw';
        throw new Error('boom: provider unreachable');
      }),
    ).rejects.toThrow('boom: provider unreachable');

    await waitForRows(1);
    expect(mocks.recordGenerationTraceRow).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'image',
        stageId: 'stage-throw',
        status: 'error',
        errorSnippet: 'boom: provider unreachable',
      }),
    );
  });

  it('tolerates a non-2xx response whose body is not JSON', async () => {
    const response = await withGenerationTrace(
      fakeRequest(),
      'video',
      async () => new NextResponse('gateway timeout', { status: 504 }),
    );

    expect(response.status).toBe(504);
    await waitForRows(1);
    expect(mocks.recordGenerationTraceRow).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'video',
        status: 'error',
        httpStatus: 504,
        errorCode: undefined,
        errorSnippet: undefined,
      }),
    );
  });

  it('resolves the owner once per request even when handler and emit both await it', async () => {
    await withGenerationTrace(fakeRequest(), 'scene-actions', async (trace) => {
      await trace.ownerId;
      await trace.ownerId;
      return NextResponse.json({ success: true });
    });
    await waitForRows(1);
    expect(mocks.readAuthAwareOwnerId).toHaveBeenCalledTimes(1);
  });

  it('never emits without DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await withGenerationTrace(fakeRequest(), 'tts', async () =>
      NextResponse.json({ success: true }),
    );
    // Give the fire-and-forget path a chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.recordGenerationTraceRow).not.toHaveBeenCalled();
  });

  it('never emits under VITEST (the guard every other suite relies on)', async () => {
    vi.stubEnv('VITEST', 'true');
    await withGenerationTrace(fakeRequest(), 'tts', async () =>
      NextResponse.json({ success: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.recordGenerationTraceRow).not.toHaveBeenCalled();
  });
});
