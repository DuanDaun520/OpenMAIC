/**
 * POST /api/my-courses/ai-cover — AI-generate a course cover image.
 *
 * The my-courses edit dialog's 「AI 生成封面」 button. Builds a cover-art
 * prompt from the course's own material (owner-scoped read, so a foreign id
 * answers the plain 404), generates a 16:9 image through the server image
 * provider (same resolution chain as /api/generate/image), persists the bytes
 * through the classroom-media path (`defaultPersistGeneratedImage`, same as
 * generated slide images), and stores the resulting URL on course_user_meta.
 *
 * The cover is per-course and shared by every viewer, so this route is
 * owner-only — enforced by the owner-scoped document store read before
 * anything is generated.
 */
import type { NextRequest } from 'next/server';

import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { quotaGateForRequest } from '@/lib/admin/quota';
import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { defaultPersistGeneratedImage } from '@/lib/server/agent-runtime/generate-image';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { buildCourseCoverPrompt, courseOutlineDigest } from '@/lib/server/course-meta-ai';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import type { ImageProviderId } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
// Image generation can run minutes on workflow providers (see /api/generate/image).
export const maxDuration = 300;

const log = createLogger('MyCoursesAICover');

export async function POST(request: NextRequest) {
  if (!isDatabaseConfigured()) return new Response('Not found', { status: 404 });

  // Quota gate: a no-op unless enforcement is double-switched on.
  const quotaGate = await quotaGateForRequest(request);
  if (quotaGate) return quotaGate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const { stageId } = body as { stageId?: unknown };
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  }

  // Provider resolution mirrors /api/generate/image: server-configured default
  // (this endpoint has no client provider preference), force-disabled check,
  // then key/baseUrl/model through the server precedence chain.
  const providerId = resolveServerImageProviderId() as ImageProviderId | undefined;
  if (!providerId) {
    return apiError('MISSING_PROVIDER', 400, 'No image provider configured');
  }
  if (isServerProviderDisabled('image', providerId)) {
    return apiError('PROVIDER_DISABLED', 403, 'This image provider is disabled by the server');
  }
  const apiKey = resolveImageApiKey(providerId, undefined);
  const provider = IMAGE_PROVIDERS[providerId];
  if (provider?.requiresApiKey && !apiKey) {
    return apiError(
      'MISSING_API_KEY',
      401,
      `No API key configured for image provider: ${providerId}`,
    );
  }
  const baseUrl = resolveImageBaseUrl(providerId, undefined);
  const model = resolveImageModel(providerId, undefined);
  if (!model && provider?.models && provider.models.length > 0) {
    return apiError('MISSING_MODEL', 400, `No model configured for image provider: ${providerId}`);
  }

  return withRequestOwnerId(request, async (ownerId, responseHeaders) => {
    // Ownership gate before any spend: the store refuses a foreign id.
    const store = await getOwnerScopedDocumentStore(ownerId);
    const document = await store.loadDocument(stageId);
    if (!document) return new Response('Not found', { status: 404, headers: responseHeaders });

    // The cover prompt lives in the shared course-meta module, so the admin
    // console's editor drafts from the same material.
    const prompt = buildCourseCoverPrompt(courseOutlineDigest(document));

    try {
      log.info(`Generating course cover: provider=${providerId}, stage=${stageId}`);
      const result = await generateImage(
        { providerId, apiKey, baseUrl, model },
        {
          prompt,
          width: 1280,
          height: 720,
        },
      );

      // Persist to the classroom-media dir and record the cover URL.
      const coverUrl = await defaultPersistGeneratedImage({
        result,
        stageId,
        signal: AbortSignal.timeout(60_000),
      });
      const pool = await getAdminPool();
      await pool.query(
        `INSERT INTO course_user_meta (stage_id, cover_url, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (stage_id) DO UPDATE SET cover_url = $2, updated_at = now()`,
        [stageId, coverUrl],
      );

      void recordGenerationUsage({
        kind: 'image',
        unit: 'image',
        providerId,
        modelId: model,
        quantity: 1,
        actor: { ownerId },
      });

      return apiSuccess({ coverUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
        return apiError('CONTENT_SENSITIVE', 400, message);
      }
      log.error(`Course cover generation failed: ${message}`, error);
      return apiError('INTERNAL_ERROR', 500, message);
    }
  });
}
