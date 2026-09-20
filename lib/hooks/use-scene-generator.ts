'use client';

import { useCallback } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import type { AgentInfo } from '@openmaic/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import {
  getEnabledProvidersWithVoices,
  resolveDeterministicFallbackVoice,
  resolveNarratorVoiceBinding,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { resolveTTSModelForVoice } from '@/lib/audio/constants';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  useGenerationLogStore,
  type GenerationLogLevel,
  type GenerationLogPhase,
} from '@/lib/store/generation-log';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { putAsset } from '@/lib/media/asset-pool';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { createLogger } from '@/lib/logger';
import { toast } from 'sonner';
import { getClientTranslation } from '@/lib/i18n';
import {
  isVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  markVoiceBindingUnavailable,
  voiceBindingKey,
} from '@/lib/audio/unavailable-voice-bindings';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@openmaic/generation';

const log = createLogger('SceneGenerator');

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  /**
   * Wall-clock of the fetch itself (including any retries), measured from the
   * moment this function is invoked — in the pipelined path that is when a
   * concurrency slot frees, so this is the true HTTP time, not pipeline wait.
   */
  durationMs?: number;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
  errorCode?: string;
  statusCode?: number;
  /** Wall-clock of the fetch itself (including any retries). */
  durationMs?: number;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown },
  fallback: string,
): Error & { errorCode?: string; statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { errorCode?: string; statusCode?: number };
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Network-level fetch failures surface from the browser as a bare TypeError
 * ("Failed to fetch"; Safari says "Load failed") — no status, no body, and no
 * server-side trace, because the request never completed. Wrap them with what
 * that actually means so the generation log (and stage_meta.generation_error)
 * records something diagnosable instead of the raw browser wording.
 */
const NETWORK_FETCH_FAILURE_RE =
  /failed to fetch|load failed|fetch failed|network error|networkerror/i;

function describeGenerationError(error: unknown, fallback: string): string {
  const message = messageFromError(error, fallback);
  if (!NETWORK_FETCH_FAILURE_RE.test(message)) return message;
  return (
    `${message}（网络层失败：请求未收到服务器响应，无 HTTP 状态码。` +
    '常见原因：网络中断、反向代理/网关超时、开发服务器重启或正在编译）'
  );
}

/**
 * Shared retry telemetry for the generation fetches — one warn per retry,
 * carrying which scene/provider it is for, the failing reason and the
 * backoff. Without this the retries happen silently and the log only ever
 * shows the final, least informative failure.
 */
function logRetry(prefix: string) {
  return (event: { attempt: number; maxAttempts: number; nextDelayMs: number; reason: string }) => {
    log.warn(
      `${prefix}: attempt ${event.attempt}/${event.maxAttempts} failed (${event.reason}), retrying in ${event.nextDelayMs}ms`,
    );
  };
}

/**
 * How often a running generation loop re-asserts its liveness. Finer than the
 * staleness windows any consumer applies (the classroom's interrupted seed,
 * the course-list badge), so one dropped pulse never reads as dead.
 */
const GENERATION_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Report this tab's generation run to the server-side liveness signal.
 *
 * Fire-and-forget by design: a pulse is advisory state, and a lost one is
 * indistinguishable from a slow scene — the next interval tick re-asserts it.
 * Only the `error` pulse is load-bearing (it persists the reason a page is
 * stuck), and losing THAT still leaves the interrupted seed to say "已中断".
 */
function sendGenerationPulse(
  stageId: string,
  kind: 'start' | 'heartbeat' | 'error',
  message?: string,
): void {
  void fetch(`/api/stages/${encodeURIComponent(stageId)}/generation-pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message === undefined ? { kind } : { kind, message }),
  }).catch(() => undefined);
}

/**
 * Tell the server the deck is finished: sets the sidecar completion flag and
 * clears the heartbeat/error signal (nothing is generating, nothing failed).
 * Also fire-and-forget — the outline document's own `generationComplete` flag
 * (persisted by the store save) remains the durable completion record.
 */
function sendGenerationComplete(stageId: string): void {
  void fetch(`/api/stages/${encodeURIComponent(stageId)}/generation-complete`, {
    method: 'POST',
  }).catch(() => undefined);
}

/**
 * Append one entry to the course's AI production log (课件AI制作日志) — the
 * timeline the stage header's log dialog shows. Messages are localized here,
 * at capture time, so an entry reads correctly even if the UI language later
 * changes.
 */
function logGeneration(
  stageId: string,
  level: GenerationLogLevel,
  phase: GenerationLogPhase,
  message: string,
  scene?: { order: number; title: string },
): void {
  useGenerationLogStore.getState().appendGenerationLog(stageId, {
    level,
    phase,
    message,
    ...(scene ? { sceneOrder: scene.order, sceneTitle: scene.title } : {}),
  });
}

/** Interpolation params naming one page, for the generationLog.m.* strings. */
function pageParams(outline: SceneOutline): { order: number; title: string } {
  return { order: outline.order, title: outline.title };
}

/**
 * Locale-neutral phase duration for the generationLog.m.* {{duration}} params
 * (messages are pre-localized at capture time, so the unit strings stay
 * language-independent): 823ms / 12.3s / 4m05s.
 */
export function formatPhaseDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}

function errorMeta(error: unknown): Pick<SceneContentResult, 'errorCode' | 'statusCode'> {
  if (!error || typeof error !== 'object') return {};
  const record = error as { errorCode?: unknown; statusCode?: unknown };
  return {
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  const startedAt = Date.now();
  try {
    const result = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        return data as unknown as SceneContentResult;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.content,
        onRetry: logRetry(
          `Scene content "${params.outline.title}" (page ${params.outline.order}, stage ${params.stageId})`,
        ),
        ...retryOptions,
        signal,
      },
    );
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn(
      `Scene content failed: "${params.outline.title}" (page ${params.outline.order}, stage ${params.stageId})`,
      error,
    );
    return {
      success: false,
      error: describeGenerationError(error, 'Content generation failed'),
      durationMs: Date.now() - startedAt,
      ...errorMeta(error),
    };
  }
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  const startedAt = Date.now();
  try {
    const result = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        onRetry: logRetry(
          `Scene actions "${params.outline.title}" (page ${params.outline.order}, stage ${params.stageId})`,
        ),
        ...retryOptions,
        signal,
      },
    );
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn(
      `Scene actions failed: "${params.outline.title}" (page ${params.outline.order}, stage ${params.stageId})`,
      error,
    );
    return {
      success: false,
      error: describeGenerationError(error, 'Actions generation failed'),
      durationMs: Date.now() - startedAt,
      ...errorMeta(error),
    };
  }
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

// A dead narrator voice is retried at most once against a DIFFERENT voice (the
// global voice when the binding differs from it, or the deterministic
// enabled-provider pick when bound == global). This bounds the total
// /api/generate/tts attempts to 2 per call and guarantees the
// QWEN_VC_VOICE_NOT_FOUND retry cannot loop a chain of dead voices
// (bound-dead → global-dead → deterministic-dead → …) forever.
const MAX_NARRATOR_VOICE_FALLBACK_HOPS = 1;

/** Generate TTS for one speech action and return its allocated asset reference. */
export async function generateAndStoreTTS(
  requestId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  existingAudioId?: string,
  stageId?: string,
  // Internal: an explicit voice that bypasses narrator binding resolution — used
  // to retry narration against the deterministic enabled-provider pick when the
  // pinned narrator voice (bound == global) turns out to be unusable.
  overrideVoice?: ResolvedVoice,
  // Internal: number of narrator voice-fallback hops already taken. Guards the
  // QWEN_VC_VOICE_NOT_FOUND retry so a chain of dead voices can never loop
  // /api/generate/tts beyond a single fallback hop.
  fallbackHops = 0,
): Promise<string | null> {
  const settings = useSettingsStore.getState();
  // A generated roster's explicit voice binding is the course voice source of truth.
  // Global settings remain the fallback for classrooms without a binding.
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const globalProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const boundVoice = teacher?.voiceConfig;
  const boundKey = boundVoice ? voiceBindingKey(boundVoice) : undefined;
  // The narrator pin makes boundVoice == the global voice. That equality must
  // not defeat the unavailable-binding fallbacks: when the pinned voice is
  // unusable (provider disabled, or the clone deleted server-side), fall back
  // to the deterministic enabled-provider pick with a single non-fatal notice
  // instead of throwing (QWEN_VC_VOICE_NOT_FOUND) or silently skipping.
  const globalDiffers =
    !!boundVoice &&
    (boundVoice.providerId !== settings.ttsProviderId || boundVoice.voiceId !== settings.ttsVoice);
  const fallbackForUnusablePin = (): ResolvedVoice | null => {
    if (!boundVoice) return null;
    const key = voiceBindingKey(boundVoice);
    markVoiceBindingUnavailable(boundVoice);
    if (markVoiceBindingNoticeShown(key)) {
      toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
    }
    return resolveDeterministicFallbackVoice(
      getEnabledProvidersWithVoices(settings.ttsProvidersConfig),
      0,
    );
  };

  let resolvedVoice =
    overrideVoice ??
    resolveNarratorVoiceBinding(
      boundVoice && isVoiceBindingUnavailable(boundVoice) ? undefined : boundVoice,
      {
        providerId: settings.ttsProviderId,
        modelId: globalProviderConfig?.modelId,
        voiceId: settings.ttsVoice,
      },
      settings.ttsProvidersConfig,
    );

  // Pinned narrator (bound == global) whose provider became disabled:
  // resolveNarratorVoiceBinding falls back to the global voice, which is the
  // same broken provider — swap in the deterministic enabled-provider pick
  // instead of silently skipping narration below.
  if (
    boundVoice &&
    !globalDiffers &&
    !isTTSProviderEnabled(
      resolvedVoice.providerId,
      settings.ttsProvidersConfig?.[resolvedVoice.providerId],
    )
  ) {
    resolvedVoice = fallbackForUnusablePin() ?? resolvedVoice;
  }

  const ttsProviderId = resolvedVoice.providerId;
  const ttsVoice = resolvedVoice.voiceId;
  const ttsProviderConfig = settings.ttsProvidersConfig?.[ttsProviderId];
  const ttsModelId = resolveTTSModelForVoice(
    ttsProviderId,
    ttsVoice,
    resolvedVoice.modelId ?? ttsProviderConfig?.modelId,
  );

  if (ttsProviderId === 'browser-native-tts') return null;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (!isTTSProviderEnabled(ttsProviderId, ttsProviderConfig)) return null;

  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: ttsProviderId,
    providerConfig: { ...ttsProviderConfig, modelId: ttsModelId },
    voiceId: ttsVoice,
    language,
  });
  let data: TTSApiResponse;
  try {
    data = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            audioId: requestId,
            // Server-side generation-trace correlation (per-course timeline);
            // dropped by JSON.stringify when undefined (browser-native clips).
            stageId,
            ttsProviderId,
            ttsModelId,
            ttsVoice,
            ttsSpeed: settings.ttsSpeed,
            ttsApiKey: ttsProviderConfig?.apiKey || undefined,
            // Managed providers resolve their base URL server-side; only send the
            // client's own base URL (custom providers).
            ttsBaseUrl:
              ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
            ttsProviderOptions: providerOptions,
          }),
          signal,
        });

        const data = (await readJsonResponse(response)) as TTSApiResponse;
        if (!response.ok) {
          throw createHttpError(response, data, 'TTS request failed');
        }
        return data;
      },
      {
        label: `tts "${requestId}"`,
        shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
        onRetry: logRetry(`TTS ${requestId} (provider ${ttsProviderId}, voice ${ttsVoice})`),
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'errorCode' in error
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    // Recover from a missing clone only when the attempt that just failed used
    // the bound binding itself: marking it unavailable makes the resolver fall
    // back to the global voice, a DIFFERENT voice. When the failure is already
    // on the global voice (or on the deterministic pick), retrying would hit
    // the same dead voice — fall through and surface the error instead of
    // hot-looping /api/generate/tts (bound-dead → global-dead → …). The
    // fallbackHops bound keeps even pathological chains at a single hop.
    if (
      errorCode === 'QWEN_VC_VOICE_NOT_FOUND' &&
      boundKey &&
      boundVoice &&
      fallbackHops < MAX_NARRATOR_VOICE_FALLBACK_HOPS
    ) {
      if (voiceBindingKey(resolvedVoice) === boundKey) {
        markVoiceBindingUnavailable(boundVoice);
        if (markVoiceBindingNoticeShown(boundKey)) {
          toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
        }
        if (globalDiffers) {
          // The binding is a voice distinct from the global one: retry with the
          // binding marked unavailable, which makes the resolver fall back to the
          // global voice.
          return generateAndStoreTTS(
            requestId,
            text,
            language,
            signal,
            retryOptions,
            existingAudioId,
            stageId,
            undefined,
            fallbackHops + 1,
          );
        }
        // Bound == global (pinned narrator): a retry would hit the same missing
        // clone, so fall back to the deterministic enabled-provider pick once.
        // (mark/notice were applied above; the helper's repeat is idempotent.)
        if (!overrideVoice) {
          const fallbackVoice = fallbackForUnusablePin();
          if (fallbackVoice) {
            return generateAndStoreTTS(
              requestId,
              text,
              language,
              signal,
              retryOptions,
              existingAudioId,
              stageId,
              fallbackVoice,
              fallbackHops + 1,
            );
          }
        }
      }
    }
    throw error;
  }
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', requestId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  const serverBacked = isServerBackedMediaPersistence();
  // Server-backed: the bytes go to the pool and the pool allocates the
  // identity, so the id the speech action ends up holding names durable audio
  // rather than this browser's local table. Bytes land BEFORE the caller
  // stamps the action, so a document can never name narration that was not
  // stored. Browser-only keeps the historical derived key: document and audio
  // share one lifetime there, and nothing outside this browser reads either.
  let audioId: string;
  if (serverBacked) {
    const allocated = await allocatePooledAudio(blob, duration, stageId).catch((error: unknown) => {
      // Storing narration failed, not synthesizing it. A scene whose audio
      // cannot be stored keeps its text and leaves the line unvoiced and
      // retryable, exactly as an image that cannot be stored leaves its slide;
      // reporting it as a TTS failure would pause the whole deck at its first
      // slide over one clip's storage.
      log.warn('Narration storage failed; leaving the line unvoiced:', error);
      return null;
    });
    if (allocated === null) return null;
    audioId = allocated;
  } else {
    audioId = existingAudioId ?? requestId;
  }
  const cacheWrite = db.audioFiles.put({
    id: audioId,
    stageId,
    blob,
    duration,
    format: data.format,
    text,
    voice: ttsVoice,
    createdAt: Date.now(),
  });
  if (serverBacked) {
    // A cache the pool already backs: a failed write costs a re-download.
    await cacheWrite.catch((error: unknown) => {
      log.warn('Local narration cache write failed for', audioId, error);
    });
  } else {
    await cacheWrite;
  }
  return audioId;
}

/**
 * Store narration bytes in the asset pool and return the reference the
 * document should hold.
 *
 * Regeneration always forks to a fresh id; the caller's `existingAudioId` is
 * deliberately ignored here. Replacing bytes behind a live id requires proof
 * that no other document holds it, and that proof is unavailable by
 * construction once references can leave this browser — asking the pool who
 * else holds an id would be exactly the existence oracle the asset contract
 * forbids, so `proveExclusiveAssetOwnership` fails closed under server-backed
 * persistence and every caller forks. Keeping a branch that can never be taken
 * would only describe a capability this deployment shape does not have.
 *
 * The superseded id is NOT removed here. Nothing at this point has observed
 * the new id reaching a durable document, so deleting the old bytes could
 * leave a still-referenced action pointing at nothing if the save that follows
 * fails; and the exclusivity that would make deletion safe is the same proof
 * that is unavailable. It does not have to be removed here: the save that
 * writes the new id is also the write that stops naming the old one, so the
 * server stamps the superseded entry as it lands and the collector releases it
 * after the grace period, the bytes following after their own. If that save
 * never lands, it is the NEW id that nothing committed, and it expires on
 * `ASSET_PENDING_TTL_MS` — either way regeneration leaves nothing permanent
 * behind.
 */
async function allocatePooledAudio(
  blob: Blob,
  duration: number | undefined,
  stageId: string | undefined,
): Promise<string> {
  return putAsset(
    blob,
    {
      contentType: blob.type,
      ...(duration === undefined ? {} : { durationSeconds: duration }),
    },
    // A write that goes through retires this course's "no room" note. This path
    // allocates directly rather than through the media commit, so without it a
    // course whose narration is generated rather than adopted has nothing that
    // can establish that.
    { ...(stageId ? { stageId } : {}) },
  );
}

/**
 * Drop the local copies of narration a scene has rolled back.
 *
 * The pool entry is deliberately left alone. Asset deletion is refused to every
 * browser — the principal it would scope to is shared, so allowing it would let
 * any caller destroy another author's narration — and a rolled-back clip is
 * simply an entry nothing references, waiting for server-side reclamation like
 * any other.
 */
export async function removeFreshTtsAllocations(assetIds: readonly string[]): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    await db.audioFiles.delete(assetId).catch(() => undefined);
  }
}

function speechAllocationIds(scene: Scene): string[] {
  return (scene.actions ?? []).flatMap((action) =>
    action.type === 'speech' && action.audioId ? [action.audioId] : [],
  );
}

/** Generate TTS for all speech actions in a scene. Returns result. */
export async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = scene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return { success: true, failedCount: 0 };

  let failedCount = 0;
  let lastError: string | undefined;
  const freshAllocations: string[] = [];

  // Scene order keeps the provider request correlation label unique. Storage
  // identity is allocated by the pool and is never derived from this value.
  const sceneOrder = scene.order;

  // Generate + store one action's audio. Failures are counted, not thrown, so
  // one bad clip never aborts the rest of the scene.
  const generateOne = async (action: SpeechAction) => {
    const requestId = `tts_s${sceneOrder}_${action.id}`;
    try {
      const assetId = await generateAndStoreTTS(
        requestId,
        action.text,
        language,
        signal,
        retryOptions,
        undefined,
        scene.stageId,
      );
      if (assetId) {
        action.audioId = assetId;
        freshAllocations.push(assetId);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId,
        actionId: action.id,
        sceneOrder,
        requestId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  };

  // #660 follow-up: speech actions within a scene are independent — each renders
  // its own audio under its own audioId, with no cross-action ordering — so when
  // the server opts into parallel generation, render them with bounded
  // concurrency (reusing the PARALLEL_SCENE_CONCURRENCY knob) instead of one at a
  // time. Default (0 / unset) keeps the original strictly-serial behaviour.
  const ttsConcurrency = Math.max(
    0,
    Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
  );
  try {
    if (ttsConcurrency > 1 && speechActions.length > 1) {
      const settled = await Promise.allSettled(
        lazyBoundedMap(speechActions, ttsConcurrency, generateOne),
      );
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) throw rejected.reason;
    } else {
      for (const action of speechActions) {
        await generateOne(action);
      }
    }
  } catch (error) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
    throw error;
  }

  if (failedCount > 0) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
  }

  return {
    success: failedCount === 0,
    failedCount,
    error: lastError,
  };
}

export interface UseSceneGeneratorOptions {
  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: 'content' | 'actions', outline: SceneOutline) => void;
  onComplete?: () => void;
}

/**
 * The tab's single live generation run.
 *
 * Course generation used to live inside the classroom component's React
 * lifecycle: unmounting the page called `stop()` and paused the deck, so a
 * course only progressed while its classroom was open. The run state now sits
 * at module scope so the loop outlives the surface that started it — leaving
 * the classroom keeps generating, with scenes landing in the global stage
 * store (persisted by its module-level scheduler) and the heartbeat keeping
 * the course-list badge truthful.
 *
 * One run per tab is a structural constraint, not a policy choice: the stage
 * store holds a single course at a time, so a `generateRemaining` call for a
 * different course supersedes the live run (aborting it) instead of running
 * beside it, and a run whose course was swapped out of the store stops itself
 * at the store's generation epoch — the same boundary that already fenced
 * cross-course scene writes.
 */
const RUN: {
  stageId: string | null;
  aborting: boolean;
  generating: boolean;
  mediaAbort: AbortController | null;
  fetchAbort: AbortController | null;
  lastParams: GenerationParams | null;
  /** Start of the newest generateRemaining run — the retry path's completed
   *  entry reports its elapsed as the deck's 总用时 (a lone retry that finishes
   *  the deck would otherwise pass off one page's time as the whole deck's). */
  startedAt: number | null;
} = {
  stageId: null,
  aborting: false,
  generating: false,
  mediaAbort: null,
  fetchAbort: null,
  lastParams: null,
  startedAt: null,
};

/** Token of the run that currently owns generation-status presentation. */
let activeGenerationRunToken = 0;

/** Latest `generateRemaining`, kept for the retry path's resume hand-off. */
let resumeGenerateRemaining: ((params: GenerationParams) => Promise<void>) | null = null;

/**
 * Decide what a `generateRemaining` call means against the live run: the same
 * course is already generating in the background (join it — no second loop),
 * another course's run still holds the shared store (supersede it), or no run
 * is live (start one).
 */
export function admitGenerationRun(
  run: { generating: boolean; stageId: string | null },
  requestedStageId: string,
): 'continue' | 'supersede' | 'start' {
  if (!run.generating) return 'start';
  return run.stageId === requestedStageId ? 'continue' : 'supersede';
}

/**
 * Whether a run may still write generation status into the shared stage
 * store. Two ownership facts must hold: the run is still the newest one (a
 * superseded run must not paint `paused` over its successor's `generating`),
 * and the store still holds this run's epoch (a course that took over the
 * store owns its own presentation). Logging, pulses, and sidecar signals stay
 * permitted regardless — they are scoped to the run's own course.
 */
export function mayPresentGenerationStatus(input: {
  runToken: number;
  activeRunToken: number;
  startEpoch: number;
  currentEpoch: number;
}): boolean {
  return input.runToken === input.activeRunToken && input.startEpoch === input.currentEpoch;
}

/** Abort the live run's fetches/media and invalidate its store epoch. */
function stopActiveGeneration(): void {
  RUN.aborting = true;
  useStageStore.getState().bumpGenerationEpoch();
  RUN.fetchAbort?.abort();
  RUN.mediaAbort?.abort();
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const store = useStageStore;

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      // Admission against the tab-wide run: joining an in-flight run of the
      // SAME course is a no-op (the background loop already carries it);
      // a DIFFERENT course's live run must be superseded first because both
      // would write into the one shared stage store.
      const requestedStageId = store.getState().stage?.id;
      if (!requestedStageId) return;
      const admission = admitGenerationRun(RUN, requestedStageId);
      if (admission === 'continue') return;
      if (admission === 'supersede') stopActiveGeneration();
      RUN.lastParams = params;
      RUN.generating = true;
      RUN.aborting = false;
      RUN.stageId = requestedStageId;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Create a new AbortController for this generation run
      RUN.fetchAbort = new AbortController();
      const signal = RUN.fetchAbort.signal;

      const state = store.getState();
      const { outlines, scenes, stage } = state;
      const startEpoch = state.generationEpoch;
      if (!stage || outlines.length === 0) {
        RUN.generating = false;
        return;
      }

      // Presentation ownership for this run: only the newest run may write
      // generation status, and only while the store still holds this run's
      // epoch. A superseded or taken-over run keeps its stage-scoped work
      // (logging, pulses, the completion sidecar) but never paints `paused`
      // or `completed` over the course that now owns the store.
      const runToken = ++activeGenerationRunToken;
      const mayPresent = () =>
        mayPresentGenerationStatus({
          runToken,
          activeRunToken: activeGenerationRunToken,
          startEpoch,
          currentEpoch: store.getState().generationEpoch,
        });

      store.getState().setGenerationStatus('generating');

      // Determine pending outlines
      const completedOrders = new Set(scenes.map((s) => s.order));
      const pending = outlines
        .filter((o) => !completedOrders.has(o.order))
        .sort((a, b) => a.order - b.order);

      if (pending.length === 0) {
        store.getState().setGenerationStatus('completed');
        store.getState().setGeneratingOutlines([]);
        store.getState().setGenerationComplete(true);
        options.onComplete?.();
        RUN.generating = false;
        return;
      }

      store.getState().setGeneratingOutlines(pending);
      // A fresh run retries every pending outline, including ones a previous
      // run failed or that were seeded as interrupted on load — their failure
      // presentation must not outlive the retry that invalidates it.
      store.getState().clearFailedOutlines();
      store.getState().clearGenerationFailure();
      logGeneration(
        stage.id,
        'info',
        'start',
        getClientTranslation('generationLog.m.start', { count: pending.length }),
      );
      // Whole-run clock, reported on the completion entry ("总用时"). On a
      // resumed run this measures the resumed run only — truthful for that run.
      const runStartedAt = Date.now();
      RUN.startedAt = runStartedAt;
      // Liveness: assert this run immediately, then on the interval below for
      // as long as it lasts. 'start' also clears the previously recorded
      // failure reason server-side (a retry invalidates it).
      sendGenerationPulse(stage.id, 'start');
      const heartbeatTimer = setInterval(() => {
        sendGenerationPulse(stage.id, 'heartbeat');
      }, GENERATION_HEARTBEAT_INTERVAL_MS);

      // Background survival ends where the shared store does. Loading another
      // classroom (or clearing the store) swaps the single course the store
      // holds, so this run must stop its fetches and its media pass at that
      // boundary — the line the classroom's unmount used to draw with stop(),
      // now drawn by the store itself so leaving the page alone no longer
      // pauses generation. The swapped-in stage already bumped the epoch, so
      // the loop below pauses at its next checkpoint on its own.
      let takenOver = false;
      const unsubscribeTakeover = store.subscribe((next) => {
        if (takenOver || next.stage?.id === stage.id) return;
        takenOver = true;
        RUN.fetchAbort?.abort();
        RUN.mediaAbort?.abort();
      });

      // Launch media generation in parallel — does not block content/action generation.
      // Under server-backed persistence, abort whatever the ref held first:
      // replacing it would orphan that loop with a signal nothing can ever
      // fire, leaving it calling providers and storing assets — real spend and
      // real storage — for a course the user may already have left, and leaving
      // `stop()` able to reach only the newest pass. The orchestrator then
      // waits for the aborted pass to settle before collecting, so the two
      // never overlap. Browser-only mode keeps its original behaviour, where an
      // overlapping pass costs a duplicate download and nothing else.
      if (isServerBackedMediaPersistence()) RUN.mediaAbort?.abort();
      RUN.mediaAbort = new AbortController();
      generateMediaForOutlines(outlines, stage.id, RUN.mediaAbort.signal).catch((err) => {
        log.warn('Media generation error:', err);
        logGeneration(
          stage.id,
          'warning',
          'media',
          getClientTranslation('generationLog.m.mediaFailed', {
            error: messageFromError(err, 'media generation failed'),
          }),
        );
      });

      // Get previousSpeeches from last completed scene
      let previousSpeeches: string[] = [];
      const sortedScenes = [...scenes].sort((a, b) => a.order - b.order);
      if (sortedScenes.length > 0) {
        const lastScene = sortedScenes[sortedScenes.length - 1];
        previousSpeeches = (lastScene.actions || [])
          .filter((a): a is SpeechAction => a.type === 'speech')
          .map((a) => a.text);
      }

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1)+TTS(1) (same as
      // serial) while later content fetches run hidden behind earlier scenes'
      // actions/TTS. Content has no cross-scene dependency, so running it ahead is
      // safe; actions + TTS stay strictly serial to preserve previousSpeeches
      // threading and the pause-on-failure UX. With parallelism off this is exactly
      // the original one-at-a-time loop.
      try {
        const fetchContent = (outline: SceneOutline) =>
          fetchSceneContent(
            {
              outline,
              allOutlines: outlines,
              stageId: stage.id,
              pdfImages: params.pdfImages,
              imageMapping: params.imageMapping,
              stageInfo: params.stageInfo,
              agents: params.agents,
              languageDirective: params.languageDirective,
            },
            signal,
          );

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: () =>
                    !RUN.aborting && store.getState().generationEpoch === startEpoch,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        let pausedByFailureOrAbort = false;
        let hadContentFailure = false;
        for (const outline of pending) {
          if (RUN.aborting || store.getState().generationEpoch !== startEpoch) {
            if (mayPresent()) store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          // This page's wall-clock contribution to the run. In parallel mode
          // the content await is often instant (pre-warmed) — the per-phase
          // entries below carry the real fetch durations instead.
          const pageStartedAt = Date.now();

          store.getState().setCurrentGeneratingOrder(outline.order);
          logGeneration(
            stage.id,
            'info',
            'content',
            getClientTranslation('generationLog.m.contentStart', pageParams(outline)),
            pageParams(outline),
          );

          // Step 1: content — await this outline's pre-warmed fetch (parallel),
          // which usually resolved while the previous scene's actions/TTS ran; or
          // fetch it now (serial).
          let contentResult: SceneContentResult;
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            contentResult = await fetchContent(outline);
          }

          if (!contentResult.success || !contentResult.content) {
            if (RUN.aborting || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            const contentError = contentResult.error || 'Content generation failed';
            store.getState().addFailedOutline(outline, contentError);
            logGeneration(
              stage.id,
              'error',
              'content',
              getClientTranslation('generationLog.m.contentFailed', {
                ...pageParams(outline),
                error: contentError,
              }),
              pageParams(outline),
            );
            sendGenerationPulse(stage.id, 'error', contentError);
            options.onSceneFailed?.(outline, contentError);
            if (contentPromises) {
              // Parallel: surface the failure but keep going with the other scenes
              // (their content is already in flight).
              hadContentFailure = true;
              removeGeneratingOutline(outline.id);
              continue;
            }
            // Serial: pause the batch (unchanged behaviour).
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          if (RUN.aborting || store.getState().generationEpoch !== startEpoch) {
            if (mayPresent()) store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          logGeneration(
            stage.id,
            'info',
            'content',
            getClientTranslation('generationLog.m.contentDone', {
              ...pageParams(outline),
              duration: formatPhaseDuration(contentResult.durationMs ?? 0),
            }),
            pageParams(outline),
          );

          // Step 2: Generate actions + assemble scene
          options.onPhaseChange?.('actions', outline);
          logGeneration(
            stage.id,
            'info',
            'actions',
            getClientTranslation('generationLog.m.actionsStart', pageParams(outline)),
            pageParams(outline),
          );
          const actionsResult = await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || outline,
              allOutlines: outlines,
              content: contentResult.content,
              stageId: stage.id,
              agents: params.agents,
              previousSpeeches,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
            },
            signal,
          );

          if (actionsResult.success && actionsResult.scene) {
            logGeneration(
              stage.id,
              'info',
              'actions',
              getClientTranslation('generationLog.m.actionsDone', {
                ...pageParams(outline),
                duration: formatPhaseDuration(actionsResult.durationMs ?? 0),
              }),
              pageParams(outline),
            );
            const scene = actionsResult.scene;
            const settings = useSettingsStore.getState();

            // TTS generation — failure means the whole scene fails
            if (
              settings.ttsEnabled &&
              settings.ttsProviderId !== 'browser-native-tts' &&
              isTTSProviderEnabled(
                settings.ttsProviderId,
                settings.ttsProvidersConfig?.[settings.ttsProviderId],
              )
            ) {
              const ttsStartedAt = Date.now();
              const ttsResult = await generateTTSForScene(
                scene,
                params.languageDirective || params.stageInfo.language,
                signal,
              );
              if (!ttsResult.success) {
                if (RUN.aborting || store.getState().generationEpoch !== startEpoch) {
                  pausedByFailureOrAbort = true;
                  break;
                }
                const ttsError = ttsResult.error || 'TTS generation failed';
                store.getState().addFailedOutline(outline, ttsError);
                logGeneration(
                  stage.id,
                  'error',
                  'actions',
                  getClientTranslation('generationLog.m.ttsFailed', {
                    ...pageParams(outline),
                    error: ttsError,
                  }),
                  pageParams(outline),
                );
                sendGenerationPulse(stage.id, 'error', ttsError);
                options.onSceneFailed?.(outline, ttsError);
                store.getState().setGenerationStatus('paused');
                pausedByFailureOrAbort = true;
                break;
              }
              // Wall-clock across the scene's clips (client-orchestrated; the
              // wall time IS the phase).
              logGeneration(
                stage.id,
                'info',
                'actions',
                getClientTranslation('generationLog.m.ttsDone', {
                  ...pageParams(outline),
                  duration: formatPhaseDuration(Date.now() - ttsStartedAt),
                }),
                pageParams(outline),
              );
            }

            // Epoch changed — stage switched, discard this scene
            if (store.getState().generationEpoch !== startEpoch) {
              await removeFreshTtsAllocations(speechAllocationIds(scene));
              pausedByFailureOrAbort = true;
              break;
            }

            removeGeneratingOutline(outline.id);
            useStageStore.getState().addScene(scene);
            logGeneration(
              stage.id,
              'success',
              'scene-done',
              getClientTranslation('generationLog.m.sceneDone', {
                ...pageParams(outline),
                duration: formatPhaseDuration(Date.now() - pageStartedAt),
              }),
              pageParams(outline),
            );
            options.onSceneGenerated?.(scene, outline.order);
            previousSpeeches = actionsResult.previousSpeeches || [];
          } else {
            if (RUN.aborting || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            const actionsError = actionsResult.error || 'Actions generation failed';
            store.getState().addFailedOutline(outline, actionsError);
            logGeneration(
              stage.id,
              'error',
              'actions',
              getClientTranslation('generationLog.m.actionsFailed', {
                ...pageParams(outline),
                error: actionsError,
              }),
              pageParams(outline),
            );
            sendGenerationPulse(stage.id, 'error', actionsError);
            options.onSceneFailed?.(outline, actionsError);
            if (mayPresent()) store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
        }

        if (!RUN.aborting && !pausedByFailureOrAbort) {
          if (hadContentFailure) {
            // Parallel content phase left some outlines failed but kept going;
            // surface them for retry instead of signalling a clean completion.
            if (mayPresent()) store.getState().setGenerationStatus('paused');
          } else {
            // Store presentation only while this run still owns the store —
            // the stage-scoped completion facts below it hold regardless.
            if (mayPresent()) {
              store.getState().setGenerationStatus('completed');
              store.getState().setGeneratingOutlines([]);
              store.getState().setGenerationComplete(true);
              store.getState().clearGenerationFailure();
            }
            logGeneration(
              stage.id,
              'success',
              'completed',
              getClientTranslation('generationLog.m.completed', {
                count: outlines.length,
                duration: formatPhaseDuration(Date.now() - runStartedAt),
              }),
            );
            // Sidecar mirror: completed + no heartbeat/error left behind.
            sendGenerationComplete(stage.id);
            options.onComplete?.();
          }
        }
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          if (mayPresent()) store.getState().setGenerationStatus('paused');
          logGeneration(
            stage.id,
            'warning',
            'paused',
            getClientTranslation('generationLog.m.paused'),
          );
        } else {
          throw err;
        }
      } finally {
        clearInterval(heartbeatTimer);
        unsubscribeTakeover();
        // Only the current run may release the tab-wide state: a superseded
        // run winding down here must not clear its successor's generating
        // flag or AbortControllers.
        if (activeGenerationRunToken === runToken) {
          RUN.generating = false;
          RUN.fetchAbort = null;
        }
      }
    },
    [options, store],
  );

  // Keep the module-level hand-off in sync so retrySingleOutline can resume
  // the remaining outlines through the tab-wide run state.
  resumeGenerateRemaining = generateRemaining;

  /** Explicitly stop the tab's live generation run (pause the deck). */
  const stop = useCallback(() => {
    stopActiveGeneration();
  }, []);

  const isGenerating = useCallback(() => RUN.generating, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      const params = RUN.lastParams;
      if (!outline || !state.stage || !params) return;
      // A whole-outline retry runs content, actions and narration on the
      // operator's keys. The surfaces already withhold the affordance when
      // generation is not permitted; refusing here keeps the precondition and
      // the render condition one rule.
      if (!mayGenerateForStage(state.stage.id)) return;
      const retryEpoch = state.generationEpoch;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      // Captured before the callbacks below: TS narrowing of `state.stage`
      // does not survive into function expressions, and the run below reads
      // it from several closures.
      const stageId = state.stage.id;

      const removeGeneratingOutline = () => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Remove from failed list and mark as generating
      store.getState().retryFailedOutline(outlineId);
      store.getState().setGenerationStatus('generating');
      store.getState().clearGenerationFailure();
      const currentGenerating = store.getState().generatingOutlines;
      if (!currentGenerating.some((o) => o.id === outline.id)) {
        store.getState().setGeneratingOutlines([...currentGenerating, outline]);
      }
      // Same liveness contract as a full run: assert immediately, re-assert on
      // the interval, and let a stale heartbeat tell the next load this run
      // died if the tab goes away mid-retry.
      sendGenerationPulse(stageId, 'start');
      const heartbeatTimer = setInterval(() => {
        sendGenerationPulse(stageId, 'heartbeat');
      }, GENERATION_HEARTBEAT_INTERVAL_MS);
      logGeneration(
        stageId,
        'info',
        'retry',
        getClientTranslation('generationLog.m.retry', pageParams(outline)),
        pageParams(outline),
      );

      const abortController = new AbortController();
      const signal = abortController.signal;

      try {
        // Whole-retry clock, reported on this outline's sceneDone entry.
        const retryStartedAt = Date.now();
        // Step 1: Content
        const contentResult = await fetchSceneContent(
          {
            outline,
            allOutlines: state.outlines,
            stageId: state.stage.id,
            pdfImages: params.pdfImages,
            imageMapping: params.imageMapping,
            stageInfo: params.stageInfo,
            agents: params.agents,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!contentResult.success || !contentResult.content) {
          const contentError = contentResult.error || 'Content generation failed';
          store.getState().addFailedOutline(outline, contentError);
          logGeneration(
            stageId,
            'error',
            'content',
            getClientTranslation('generationLog.m.contentFailed', {
              ...pageParams(outline),
              error: contentError,
            }),
            pageParams(outline),
          );
          sendGenerationPulse(stageId, 'error', contentError);
          return;
        }

        logGeneration(
          stageId,
          'info',
          'content',
          getClientTranslation('generationLog.m.contentDone', {
            ...pageParams(outline),
            duration: formatPhaseDuration(contentResult.durationMs ?? 0),
          }),
          pageParams(outline),
        );

        // Step 2: Actions
        const sortedScenes = [...store.getState().scenes].sort((a, b) => a.order - b.order);
        const lastScene = sortedScenes[sortedScenes.length - 1];
        const previousSpeeches = lastScene
          ? (lastScene.actions || [])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text)
          : [];

        const actionsResult = await fetchSceneActions(
          {
            outline: contentResult.effectiveOutline || outline,
            allOutlines: state.outlines,
            content: contentResult.content,
            stageId: state.stage.id,
            agents: params.agents,
            previousSpeeches,
            userProfile: params.userProfile,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!actionsResult.success || !actionsResult.scene) {
          const actionsError = actionsResult.error || 'Actions generation failed';
          store.getState().addFailedOutline(outline, actionsError);
          logGeneration(
            stageId,
            'error',
            'actions',
            getClientTranslation('generationLog.m.actionsFailed', {
              ...pageParams(outline),
              error: actionsError,
            }),
            pageParams(outline),
          );
          sendGenerationPulse(stageId, 'error', actionsError);
          return;
        }

        logGeneration(
          stageId,
          'info',
          'actions',
          getClientTranslation('generationLog.m.actionsDone', {
            ...pageParams(outline),
            duration: formatPhaseDuration(actionsResult.durationMs ?? 0),
          }),
          pageParams(outline),
        );

        // Step 3: TTS
        const settings = useSettingsStore.getState();
        if (
          settings.ttsEnabled &&
          settings.ttsProviderId !== 'browser-native-tts' &&
          isTTSProviderEnabled(
            settings.ttsProviderId,
            settings.ttsProvidersConfig?.[settings.ttsProviderId],
          )
        ) {
          const ttsStartedAt = Date.now();
          const ttsResult = await generateTTSForScene(
            actionsResult.scene,
            params.languageDirective || params.stageInfo.language,
            signal,
          );
          if (!ttsResult.success) {
            const ttsError = ttsResult.error || 'TTS generation failed';
            store.getState().addFailedOutline(outline, ttsError);
            logGeneration(
              stageId,
              'error',
              'actions',
              getClientTranslation('generationLog.m.ttsFailed', {
                ...pageParams(outline),
                error: ttsError,
              }),
              pageParams(outline),
            );
            sendGenerationPulse(stageId, 'error', ttsError);
            return;
          }
          logGeneration(
            stageId,
            'info',
            'actions',
            getClientTranslation('generationLog.m.ttsDone', {
              ...pageParams(outline),
              duration: formatPhaseDuration(Date.now() - ttsStartedAt),
            }),
            pageParams(outline),
          );
        }

        if (store.getState().generationEpoch !== retryEpoch) {
          await removeFreshTtsAllocations(speechAllocationIds(actionsResult.scene));
          return;
        }

        removeGeneratingOutline();
        useStageStore.getState().addScene(actionsResult.scene);
        logGeneration(
          stageId,
          'success',
          'scene-done',
          getClientTranslation('generationLog.m.sceneDone', {
            ...pageParams(outline),
            duration: formatPhaseDuration(Date.now() - retryStartedAt),
          }),
          pageParams(outline),
        );

        // Resume remaining generation if there are pending outlines
        if (store.getState().generatingOutlines.length > 0 && RUN.lastParams) {
          resumeGenerateRemaining?.(RUN.lastParams);
        } else if (store.getState().generationEpoch === retryEpoch) {
          // This retry may have materialized the final outstanding slide. The
          // generateRemaining completion path is not reached on the retry flow,
          // so mark completion here too — otherwise a later delete would treat
          // the orphaned outline as pending and regenerate it. The epoch fence
          // keeps a winding-down retry from marking a course that has since
          // taken over the store as complete.
          store.getState().markGenerationCompleteIfDone();
          if (useStageStore.getState().generationComplete) {
            store.getState().clearGenerationFailure();
            logGeneration(
              stageId,
              'success',
              'completed',
              getClientTranslation('generationLog.m.completed', {
                count: store.getState().outlines.length,
                // The deck's 总用时 spans the whole run, not just this retry.
                duration: formatPhaseDuration(Date.now() - (RUN.startedAt ?? retryStartedAt)),
              }),
            );
            sendGenerationComplete(stageId);
          }
        }
      } catch (err) {
        if (!isAbortError(err)) {
          const retryError = messageFromError(err, 'Generation failed');
          store.getState().addFailedOutline(outline, retryError);
          logGeneration(
            stageId,
            'error',
            'content',
            getClientTranslation('generationLog.m.failed', {
              ...pageParams(outline),
              error: retryError,
            }),
            pageParams(outline),
          );
          sendGenerationPulse(stageId, 'error', retryError);
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    },
    [store],
  );

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}
