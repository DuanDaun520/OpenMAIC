/**
 * POST /api/admin/courses/ai — the admin console's course editor AI buttons.
 *
 * Admin-authored twins of /api/my-courses/ai-meta and /api/my-courses/ai-cover:
 * the same shared prompts (lib/server/course-meta-ai), the same model and
 * image-provider resolution chains, the same persistence targets — but the
 * authority is the admin session and the document read rides the owner-bound
 * store under the course's real owner. Suggested 标题/介绍 come back unsaved
 * (保存 rides PATCH /api/admin/courses updateInfo); the generated cover is
 * persisted immediately, exactly like the owner's own button.
 */
import type { NextRequest } from 'next/server';

import { callLLM } from '@/lib/ai/llm';
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { getAdminPool, isDatabaseConfigured } from '@/lib/admin/db';
import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { defaultPersistGeneratedImage } from '@/lib/server/agent-runtime/generate-image';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import {
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
} from '@/lib/server/agent-runtime/stage-limits';
import {
  buildCourseCoverPrompt,
  buildCourseMetaPrompts,
  courseOutlineDigest,
  extractJsonObject,
} from '@/lib/server/course-meta-ai';
import {
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
// Image generation can run minutes on workflow providers (see /api/generate/image).
export const maxDuration = 300;

const log = createLogger('AdminCoursesAI');

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  if (!isDatabaseConfigured()) {
    return apiError('INTERNAL_ERROR', 503, '课程管理需要配置 DATABASE_URL');
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }
  const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
  const kind = body.kind;
  if (!stageId) return apiError('INVALID_REQUEST', 400, '需要 stageId');
  if (kind !== 'meta' && kind !== 'cover') {
    return apiError('INVALID_REQUEST', 400, 'kind 需为 meta 或 cover');
  }

  // The course's real owner: the document read must ride the owner-bound
  // store so the digest comes from the same storage domain the owner uses.
  const pool = await getAdminPool();
  const stage = await pool.query<{ name: string; owner_id: string | null }>(
    `SELECT s.name, COALESCE(m.owner_id, s.owner_id) AS owner_id
       FROM document_stages s
       LEFT JOIN stage_meta m ON m.stage_id = s.id
      WHERE s.id = $1`,
    [stageId],
  );
  const row = stage.rows[0];
  if (!row || !row.owner_id) {
    return apiError('INVALID_REQUEST', 409, '课程没有所有者，无法读取内容');
  }

  const store = await getOwnerScopedDocumentStore(row.owner_id);
  const document = await store.loadDocument(stageId);
  if (!document) return apiError('INVALID_REQUEST', 404, '课程不存在');

  if (kind === 'meta') {
    const { system, user } = buildCourseMetaPrompts(courseOutlineDigest(document));
    try {
      const { model: languageModel, modelInfo } = await resolveModelFromRequest(
        request,
        body,
        'agent-profiles',
      );
      const result = await callLLM(
        {
          model: languageModel,
          system,
          prompt: user,
          maxOutputTokens: modelInfo?.outputWindow ? Math.min(modelInfo.outputWindow, 1024) : 1024,
          maxRetries: 0,
        },
        'admin-courses-ai-meta',
      );
      const parsed = extractJsonObject(result.text);
      const title =
        typeof parsed?.title === 'string'
          ? parsed.title.trim().slice(0, STAGE_NAME_MAX_LENGTH)
          : '';
      const description =
        typeof parsed?.description === 'string'
          ? parsed.description.trim().slice(0, STAGE_DESCRIPTION_MAX_LENGTH)
          : '';
      await recordAudit(guard.session, {
        action: 'course.aiMeta',
        targetType: 'course',
        targetId: stageId,
        ip: requestIp(request),
      });
      if (!title && !description) {
        return Response.json({ success: false, error: 'AI 未返回有效的标题或介绍，请重试' });
      }
      return Response.json({
        success: true,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ success: false, error: `生成失败：${message}` });
    }
  }

  // kind === 'cover': provider resolution mirrors /api/my-courses/ai-cover.
  const providerId = resolveServerImageProviderId() as ImageProviderId | undefined;
  if (!providerId) return apiError('MISSING_PROVIDER', 400, 'No image provider configured');
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

  const prompt = buildCourseCoverPrompt(courseOutlineDigest(document));
  try {
    log.info(`Generating admin course cover: provider=${providerId}, stage=${stageId}`);
    const result = await generateImage(
      { providerId, apiKey, baseUrl, model },
      { prompt, width: 1280, height: 720 },
    );
    const coverUrl = await defaultPersistGeneratedImage({
      result,
      stageId,
      signal: AbortSignal.timeout(60_000),
    });
    await pool.query(
      `INSERT INTO course_user_meta (stage_id, cover_url, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (stage_id) DO UPDATE SET cover_url = $2, updated_at = now()`,
      [stageId, coverUrl],
    );
    // Usage attributes to the course's owner — it is their course the bytes
    // were generated for, whoever clicked the button.
    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId,
      modelId: model,
      quantity: 1,
      actor: { ownerId: row.owner_id },
    });
    await recordAudit(guard.session, {
      action: 'course.aiCover',
      targetType: 'course',
      targetId: stageId,
      ip: requestIp(request),
    });
    return apiSuccess({ coverUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(`Admin course cover generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
