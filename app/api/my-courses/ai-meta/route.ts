/**
 * POST /api/my-courses/ai-meta — AI-draft the course title and intro.
 *
 * The my-courses edit dialog's 「AI 生成」 button for 标题/介绍. Reads the
 * course's own material (requirement + outline titles) through the
 * owner-scoped document store — ownership is enforced by the store, so a
 * foreign id answers the plain 404 — and asks the resolved model for a strict
 * JSON pair: a title (≤120 chars) and a ≤200-character intro, matching the
 * product requirement for the dialog. The suggestion is returned, not saved:
 * saving goes through the dialog's explicit 保存 (PATCH /api/stages/[id]).
 */
import type { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { isDatabaseConfigured } from '@/lib/admin/db';
import { apiError } from '@/lib/server/api-response';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
} from '@/lib/server/agent-runtime/stage-limits';
import {
  buildCourseMetaPrompts,
  courseOutlineDigest,
  extractJsonObject,
} from '@/lib/server/course-meta-ai';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';
export const maxDuration = 60;

const INTRO_MAX_LENGTH = STAGE_DESCRIPTION_MAX_LENGTH;

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const { stageId } = body as { stageId?: unknown };
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const store = await getOwnerScopedDocumentStore(ownerId);
    const document = await store.loadDocument(stageId);
    if (!document) return ownerNotFound(responseHeaders);

    // Compact course digest + prompts live in the shared course-meta module,
    // so the admin console's editor drafts from the same material.
    const { system: systemPrompt, user: userPrompt } = buildCourseMetaPrompts(
      courseOutlineDigest(document),
    );

    try {
      const { model: languageModel, modelInfo } = await resolveModelFromRequest(
        req,
        body,
        'agent-profiles',
      );
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: modelInfo?.outputWindow ? Math.min(modelInfo.outputWindow, 1024) : 1024,
          maxRetries: 0,
        },
        'my-courses-ai-meta',
      );

      const parsed = extractJsonObject(result.text);
      const title =
        typeof parsed?.title === 'string'
          ? parsed.title.trim().slice(0, STAGE_NAME_MAX_LENGTH)
          : '';
      const description =
        typeof parsed?.description === 'string'
          ? parsed.description.trim().slice(0, INTRO_MAX_LENGTH)
          : '';
      if (!title && !description) {
        return ownerJson(
          { success: false, error: 'AI 未返回有效的标题或介绍，请重试' },
          200,
          responseHeaders,
        );
      }
      return ownerJson(
        { success: true, ...(title ? { title } : {}), ...(description ? { description } : {}) },
        200,
        responseHeaders,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ownerJson({ success: false, error: `生成失败：${message}` }, 200, responseHeaders);
    }
  });
}
