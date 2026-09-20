/**
 * /api/admin/voices — TTS voice catalog management (音色管理).
 *
 * - GET     lists every built-in TTS provider's full voice table with any
 *           override applied (renamed / re-gendered / hidden / appended
 *           custom voice), plus the raw override rows, so the console edits
 *           the effective catalog rather than a diff view.
 * - PUT     upserts one (providerId, voiceId) override row. A row whose
 *           voiceId is not a preset ADDS that voice to the provider's picker
 *           list; `hidden: true` removes a voice from every picker.
 * - DELETE  drops an override, falling that voice back to the registry
 *           preset.
 *
 * Writes patch the in-memory overlay synchronously (write-through), so the
 * running server — including the public /api/voice-overrides surface — serves
 * the change on the next request without a restart.
 */
import { recordAudit, requestIp } from '@/lib/admin/audit';
import { requireAdmin } from '@/lib/admin/auth';
import { getAdminPool } from '@/lib/admin/db';
import {
  type VoiceOverrideRow,
  loadVoiceOverrideRows,
  patchVoiceOverrideRow,
} from '@/lib/admin/voice-overrides';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { applyVoiceOverrides } from '@/lib/audio/voice-override-rules';
import { apiError } from '@/lib/server/api-response';

export const runtime = 'nodejs';

const GENDERS = new Set(['male', 'female', 'neutral']);

function builtinTTSProviderIds(): string[] {
  return Object.entries(TTS_PROVIDERS)
    .filter(([id]) => id !== 'browser-native-tts')
    .map(([id]) => id);
}

function toClientRow(row: VoiceOverrideRow) {
  return {
    providerId: row.providerId,
    voiceId: row.voiceId,
    name: row.name,
    language: row.language,
    gender: row.gender,
    description: row.description,
    hidden: row.hidden,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt,
  };
}

export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const rows = await loadVoiceOverrideRows();
  const byProvider = new Map<string, VoiceOverrideRow[]>();
  for (const row of rows) {
    const list = byProvider.get(row.providerId) ?? [];
    list.push(row);
    byProvider.set(row.providerId, list);
  }

  const providers = builtinTTSProviderIds().map((providerId) => {
    const config = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
    const overrideRows = byProvider.get(providerId) ?? [];
    const rowByVoiceId = new Map(overrideRows.map((row) => [row.voiceId, row]));
    // Console view: every preset (hidden ones retained, flagged) with its
    // override applied, then non-preset additions. The picker-facing merge
    // (applyVoiceOverrides) drops hidden rows — here they must stay visible
    // so the operator can un-hide them.
    const voices = [
      ...config.voices.map((voice) => {
        const row = rowByVoiceId.get(voice.id);
        const merged = applyVoiceOverrides([voice], row ? [row] : [])[0];
        return {
          ...merged,
          hidden: row?.hidden === true,
          overridden: !!row,
          isCustomAddition: false,
        };
      }),
      ...overrideRows
        .filter((row) => !config.voices.some((voice) => voice.id === row.voiceId))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.voiceId.localeCompare(b.voiceId))
        .map((row) => ({
          id: row.voiceId,
          name: row.name || row.voiceId,
          ...(row.language ? { language: row.language } : {}),
          ...(row.gender ? { gender: row.gender } : {}),
          ...(row.description ? { description: row.description } : {}),
          hidden: row.hidden,
          overridden: true,
          isCustomAddition: true,
        })),
    ];
    return {
      providerId,
      providerName: config.name,
      voices,
      overrides: overrideRows.map(toClientRow),
    };
  });

  // Rows keyed at a provider id outside the built-in registry (e.g. one was
  // renamed upstream) — surfaced so the console can clean them up.
  const builtin = new Set(builtinTTSProviderIds());
  const orphaned = rows.filter((row) => !builtin.has(row.providerId)).map(toClientRow);

  return Response.json({ success: true, providers, orphaned });
}

interface VoicePutBody {
  providerId?: unknown;
  voiceId?: unknown;
  name?: unknown;
  language?: unknown;
  gender?: unknown;
  description?: unknown;
  hidden?: unknown;
  sortOrder?: unknown;
}

export async function PUT(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  let body: VoicePutBody;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, '请求体不是合法 JSON');
  }

  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
  const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : '';
  if (!Object.hasOwn(TTS_PROVIDERS, providerId) || providerId === 'browser-native-tts') {
    return apiError(
      'INVALID_REQUEST',
      400,
      'providerId 必须是内置 TTS Provider（非 browser-native）',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(voiceId)) {
    return apiError('INVALID_REQUEST', 400, 'voiceId 格式不合法');
  }

  const isPreset = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS].voices.some(
    (voice) => voice.id === voiceId,
  );
  const name = body.name === undefined || body.name === null ? null : String(body.name).trim();
  if (!name && !isPreset) {
    return apiError('INVALID_REQUEST', 400, '新增音色必须填写显示名称');
  }
  const language =
    typeof body.language === 'string' && body.language.trim() ? body.language.trim() : null;
  const gender =
    typeof body.gender === 'string' && GENDERS.has(body.gender)
      ? (body.gender as VoiceOverrideRow['gender'])
      : null;
  const description =
    typeof body.description === 'string' && body.description.trim()
      ? body.description.trim()
      : null;
  const hidden = body.hidden === undefined ? false : Boolean(body.hidden);
  const sortOrder =
    typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : 0;

  const pool = await getAdminPool();
  await pool.query(
    `INSERT INTO voice_overrides
       (provider_id, voice_id, name, language, gender, description, hidden, sort_order, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (provider_id, voice_id) DO UPDATE SET
       name = EXCLUDED.name,
       language = EXCLUDED.language,
       gender = EXCLUDED.gender,
       description = EXCLUDED.description,
       hidden = EXCLUDED.hidden,
       sort_order = EXCLUDED.sort_order,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      providerId,
      voiceId,
      name || null,
      language,
      gender,
      description,
      hidden,
      sortOrder,
      guard.session.userId,
    ],
  );

  const row: VoiceOverrideRow = {
    providerId,
    voiceId,
    name: name || null,
    language,
    gender,
    description,
    hidden,
    sortOrder,
    updatedBy: guard.session.userId,
    updatedAt: new Date().toISOString(),
  };
  patchVoiceOverrideRow(row, { providerId, voiceId });

  await recordAudit(guard.session, {
    action: 'voice.upsert',
    targetType: 'voice_override',
    targetId: `${providerId}:${voiceId}`,
    detail: { name: row.name, gender, language, hidden, isPreset },
    ip: requestIp(request),
  });

  return Response.json({ success: true, row: toClientRow(row) });
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin(request, { mutation: true, minRole: 'admin' });
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const providerId = (url.searchParams.get('providerId') ?? '').trim();
  const voiceId = (url.searchParams.get('voiceId') ?? '').trim();
  if (!providerId || !voiceId) {
    return apiError('INVALID_REQUEST', 400, '需要 providerId 与 voiceId 查询参数');
  }

  const pool = await getAdminPool();
  const result = await pool.query(
    'DELETE FROM voice_overrides WHERE provider_id = $1 AND voice_id = $2',
    [providerId, voiceId],
  );
  if (result.rowCount === 0) {
    return apiError('INVALID_REQUEST', 404, '该覆盖配置不存在');
  }
  patchVoiceOverrideRow(null, { providerId, voiceId });

  await recordAudit(guard.session, {
    action: 'voice.delete',
    targetType: 'voice_override',
    targetId: `${providerId}:${voiceId}`,
    ip: requestIp(request),
  });
  return new Response(null, { status: 204 });
}
