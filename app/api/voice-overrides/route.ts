/**
 * /api/voice-overrides — the admin-curated voice overlay for clients.
 *
 * Public and secret-free (names/genders/languages only — the same metadata the
 * TTS_PROVIDERS registry already ships in the client bundle). The client keeps
 * a module-level cache warm via ensureVoiceOverridesLoaded() and folds these
 * rows into every voice list, so what the picker shows is what the admin
 * curated, without a deploy.
 */
import { loadVoiceOverrideRows } from '@/lib/admin/voice-overrides';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const rows = await loadVoiceOverrideRows();
    return Response.json(
      {
        rows: rows.map((row) => ({
          providerId: row.providerId,
          voiceId: row.voiceId,
          name: row.name,
          language: row.language,
          gender: row.gender,
          description: row.description,
          hidden: row.hidden,
          sortOrder: row.sortOrder,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // DB not configured (local/browser mode) or transient failure: an empty
    // overlay must not break the picker — presets apply unchanged.
    console.error('[voice-overrides] listing failed; serving empty overlay', error);
    return Response.json({ rows: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
