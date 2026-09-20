/**
 * POST /api/stages/[id]/generation-pulse
 *
 * The generation liveness signal for client-driven courses. The browser that
 * is generating a deck's pages is the only thing that knows generation is
 * actually happening — a pending outline alone cannot tell "a live tab is
 * working on it" from "the tab died mid-run" — so the generating tab reports
 * itself here while it runs, and reports the reason when it fails.
 *
 * Three pulses, all owner-only (generation spends the owner's provider
 * budget, so a stranger must never be able to forge liveness for a course):
 * - `{ kind: 'start' }`    → fresh heartbeat + clears any recorded error (a
 *   retry invalidates the previous failure reason).
 * - `{ kind: 'heartbeat' }`→ fresh heartbeat, error untouched.
 * - `{ kind: 'error', message }` → records the failure reason and drops the
 *   heartbeat (the run is over; the course must not keep looking live).
 *
 * Heartbeats are written to stage_meta only — never document_stages — so a
 * generating course does not keep bubbling to the top of the My Courses list
 * (which orders by the document's updated_at).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { recordGenerationError, touchGenerationHeartbeat } from '@/lib/persistence/stage-meta';
import { getStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Bound the stored failure reason: a diagnosis, not a log sink. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

export async function POST(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  let body: { kind?: unknown; message?: unknown };
  try {
    body = (await req.json()) as { kind?: unknown; message?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const kind = body.kind;
  if (kind !== 'start' && kind !== 'heartbeat' && kind !== 'error') {
    return NextResponse.json(
      { error: 'invalid_request', details: 'kind must be start, heartbeat, or error' },
      { status: 400 },
    );
  }
  let message: string | null = null;
  if (kind === 'error') {
    message =
      typeof body.message === 'string' && body.message.length > 0
        ? body.message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
        : null;
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id: stageId } = await params;
    try {
      const access = await resolveStageAccess(stageId);

      // Absent and tombstoned are the same 404 — no oracle for used-to-exist.
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      // Owner only: liveness and failure reasons describe the owner's own
      // generation run; nobody else may write them.
      if (access.ownerId !== ownerId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
      }

      const db = await getStageAccessDb();
      const touched =
        kind === 'error'
          ? await recordGenerationError(db, stageId, message)
          : await touchGenerationHeartbeat(db, stageId, kind === 'start');

      if (!touched) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error('Failed to record generation pulse', {
        stageId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  });
}
