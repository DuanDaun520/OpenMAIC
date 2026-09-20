import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  persistenceConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  accessRow: null as Record<string, unknown> | null,
  updatedRows: [] as unknown[],
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
  isServerPersistenceConfigured: () => mocks.persistenceConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: {
      query: vi.fn(async (text: string) => {
        if (text.includes('UPDATE stage_meta')) {
          return { rows: mocks.updatedRows };
        }
        if (text.includes('LEFT JOIN stage_meta')) {
          if (!mocks.accessRow) return { rows: [] };
          return { rows: [mocks.accessRow] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(),
        release: vi.fn(),
      })),
    },
  }),
}));

import { GET as getStageMeta } from '@/app/api/stage-meta/[stageId]/route';
import { POST as postGenerationComplete } from '@/app/api/stages/[id]/generation-complete/route';

const STAGE_ID = 'stage-1';
const stageMetaParams = (stageId: string) => ({ params: Promise.resolve({ stageId }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.persistenceConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.accessRow = {
    meta_owner_id: 'owner-1',
    meta_is_public: false,
    meta_published_at: null,
    meta_generation_complete: false,
    meta_deleted_at: null,
    document_name: 'Course',
    cover_url: '/api/classroom-media/x/media/generated-cover.png',
  };
  mocks.updatedRows = [{ stage_id: STAGE_ID }];
});

describe('GET /api/stage-meta/[stageId]', () => {
  it('returns the per-viewer facts for the owner', async () => {
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      isOwner: true,
      isPublic: false,
      publishedAt: null,
      generationComplete: false,
      coverUrl: '/api/classroom-media/x/media/generated-cover.png',
      source: 'document',
    });
  });

  it('reports a visitor as non-owner', async () => {
    mocks.accessRow!.meta_owner_id = 'someone-else';
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    await expect(response.json()).resolves.toMatchObject({ isOwner: false });
  });

  it('answers 404 for an absent or tombstoned course', async () => {
    mocks.accessRow = {
      meta_owner_id: null,
      meta_is_public: false,
      meta_published_at: null,
      meta_generation_complete: false,
      meta_deleted_at: null,
      document_name: null,
    };
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });

  // The sidecar reports who owns a persisted course. Every persisted course has
  // an owner — the persistence route resolves one for each request — so gating
  // this endpoint on the agent runtime made it answer "no such course" for every
  // course of a persistence-only deployment, leaving its viewers with no
  // ownership signal at all.
  it('answers with server persistence configured and the agent runtime off', async () => {
    mocks.runtimeConfigured = false;
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ isOwner: true });
  });

  it('gates on configured server persistence', async () => {
    mocks.persistenceConfigured = false;
    const response = await getStageMeta(
      new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
      stageMetaParams(STAGE_ID),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/stages/[id]/generation-complete', () => {
  it('marks the owner’s course generation-complete', async () => {
    const response = await postGenerationComplete(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/generation-complete`, {
        method: 'POST',
      }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('forbids a visitor', async () => {
    mocks.accessRow!.meta_owner_id = 'someone-else';
    const response = await postGenerationComplete(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}/generation-complete`, {
        method: 'POST',
      }),
      params(STAGE_ID),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
  });
});
