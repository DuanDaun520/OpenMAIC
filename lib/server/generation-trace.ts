/**
 * Generation-route trace wrapper — one row per HTTP call into
 * `generation_trace`, durations and failures included, so the admin console
 * can answer "where did this course's generation time go".
 *
 * The wrapper owns everything a route cannot know at its many return points:
 * wall-clock duration, final HTTP status, and (for non-2xx) the error code +
 * snippet read from a CLONE of the response body — the original body is
 * untouched and still streams to the client. Route handlers only fill a
 * mutable `trace` context with what they parse anyway (stageId, page,
 * provider/model), so validation 400s and quota 429s are traced for free.
 *
 * Emission is fire-and-forget with the usage-storage guard discipline: tests
 * and pure-client deployments (no DATABASE_URL) never touch the pg stack —
 * the dynamic import keeps this module's static graph free of it for tests
 * and non-DB builds.
 */
import type { NextResponse } from 'next/server';
import { readAuthAwareOwnerId } from '@/lib/server/agent-runtime/auth-owner';
import type { GenerationTraceInsert, GenerationTraceStep } from '@/lib/admin/generation-trace-db';

export type { GenerationTraceStep };

/** Mutable per-request fields the route handler fills in as it parses input. */
export interface GenerationTraceContext {
  stageId?: string;
  page?: number;
  providerId?: string;
  modelId?: string;
  /**
   * Resolved once per request, concurrently with the handler (a session
   * lookup hides behind generation time). Routes that record usage should
   * await THIS promise instead of calling readAuthAwareOwnerId again — a
   * course's TTS burst is ~100 calls and must not double the lookups.
   */
  ownerId: Promise<string | undefined>;
}

const SNIPPET_MAX = 300;

function snippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

function snippetFromError(error: unknown): string {
  return snippet(error instanceof Error ? error.message : String(error));
}

/** Never throws, never blocks: the sink itself swallows its failures. */
function emitGenerationTrace(row: GenerationTraceInsert): void {
  // Tests never write; no-DB deployments never import the pg stack.
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  if (!process.env.DATABASE_URL?.trim()) return;
  void (async () => {
    try {
      const { recordGenerationTraceRow } = await import('@/lib/admin/generation-trace-db');
      await recordGenerationTraceRow(row);
    } catch {
      // Unreachable in practice — the sink swallows its own errors — but a
      // trace must never take generation down, whatever happens.
    }
  })();
}

export async function withGenerationTrace(
  req: Pick<Request, 'headers'>,
  step: GenerationTraceStep,
  handler: (trace: GenerationTraceContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const startedAt = Date.now();
  const ownerId = readAuthAwareOwnerId(req).catch(() => undefined);
  const trace: GenerationTraceContext = { ownerId };

  let response: NextResponse;
  try {
    response = await handler(trace);
  } catch (error) {
    emitGenerationTrace({
      step,
      stageId: trace.stageId,
      ownerId: await ownerId,
      page: trace.page,
      providerId: trace.providerId,
      modelId: trace.modelId,
      durationMs: Date.now() - startedAt,
      status: 'error',
      errorSnippet: snippetFromError(error),
    });
    throw error;
  }

  const ok = response.status >= 200 && response.status < 300;
  let errorCode: string | undefined;
  let errorSnippet: string | undefined;
  if (!ok) {
    // Read the error fields without consuming the body the client receives.
    const body = (await response
      .clone()
      .json()
      .catch(() => undefined)) as
      | { errorCode?: unknown; error?: unknown; details?: unknown }
      | undefined;
    if (typeof body?.errorCode === 'string') errorCode = body.errorCode;
    const message = body?.details ?? body?.error;
    if (typeof message === 'string' && message) errorSnippet = snippet(message);
  }

  emitGenerationTrace({
    step,
    stageId: trace.stageId,
    ownerId: await ownerId,
    page: trace.page,
    providerId: trace.providerId,
    modelId: trace.modelId,
    durationMs: Date.now() - startedAt,
    status: ok ? 'ok' : 'error',
    httpStatus: response.status,
    errorCode,
    errorSnippet,
  });
  return response;
}
