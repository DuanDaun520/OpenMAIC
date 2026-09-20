/**
 * Doubao speaker remapping — pure helpers, extracted from the TTS adapter so
 * the gender/language rules are unit-testable without the provider stack.
 *
 * A speech grant binds its resource id to a voice family: `seed-tts-2.0`
 * serves the uranus voices, while the 大模型语音合成 service types (e.g.
 * `volc.service_type.10029`) serve the other `_bigtts` families (moon, mars,
 * …). A cross-family pair is rejected with 55000000, and speakers reach the
 * adapter from many persisted places (course agent bindings, the settings
 * store, picker defaults) that may predate the operator's grant. Rather than
 * letting those requests fail, remap a cross-family speaker to a compatible
 * one — deterministically per source voice, so distinct agents stay distinct
 * after remapping. Unknown speaker shapes (e.g. cloned voices) pass through.
 */

export const DOUBAO_RESOURCE_VOICE_POOLS: Record<string, readonly string[]> = {
  'seed-tts-2.0': [
    'zh_female_vv_uranus_bigtts',
    'zh_female_xiaohe_uranus_bigtts',
    'zh_male_m191_uranus_bigtts',
    'en_female_dacey_uranus_bigtts',
    'en_male_tim_uranus_bigtts',
  ],
  // Voices verified against a live 10029 grant — extend as more are authorized.
  'volc.service_type.10029': [
    'zh_female_shuangkuaisisi_moon_bigtts',
    'zh_male_beijingxiaoye_emo_v2_mars_bigtts',
  ],
};

/** The language+gender a Doubao speaker id declares via its prefix. */
export interface SpeakerTraits {
  language: 'zh' | 'en';
  gender: 'male' | 'female';
}

/**
 * Parse `<lang>_<gender>_<name>` prefixes (zh_female_…, en_male_…). Returns
 * undefined for ids without a recognizable prefix (clones, future shapes).
 */
export function parseSpeakerTraits(speaker: string): SpeakerTraits | undefined {
  const match = /^(zh|en)_(male|female)_/.exec(speaker);
  if (!match) return undefined;
  return { language: match[1] as 'zh' | 'en', gender: match[2] as 'male' | 'female' };
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

/**
 * Pick a pool speaker standing in for `speaker`, preserving its declared
 * gender (and language when the pool allows): the picker shows the ORIGINAL
 * voice's name/gender, so a female-labeled selection must never come back as
 * a male speaker — that mismatch is exactly the "男声女名" bug. Fallback order:
 * same language+gender → same gender → whole pool (when the pool cannot honor
 * either, e.g. a single-voice pool).
 */
export function pickPooledSpeaker(pool: readonly string[], speaker: string): string {
  if (pool.length === 0) return speaker;
  const traits = parseSpeakerTraits(speaker);
  if (!traits) return pool[hashString(speaker) % pool.length];

  const sameLangAndGender = pool.filter((candidate) => {
    const candidateTraits = parseSpeakerTraits(candidate);
    return (
      candidateTraits?.language === traits.language && candidateTraits?.gender === traits.gender
    );
  });
  const sameGender = pool.filter((candidate) => {
    const candidateTraits = parseSpeakerTraits(candidate);
    return candidateTraits?.gender === traits.gender;
  });

  const candidates = sameLangAndGender.length > 0 ? sameLangAndGender : sameGender;
  if (candidates.length === 0) return pool[hashString(speaker) % pool.length];
  return candidates[hashString(speaker) % candidates.length];
}

/**
 * Remap `speaker` to a voice family the resource actually serves. Only a
 * positively-identified cross-family speaker is rewritten; everything else
 * (in-family voices, clone ids, future families) passes through untouched.
 */
export function remapDoubaoSpeaker(resourceId: string, speaker: string): string {
  const pool = DOUBAO_RESOURCE_VOICE_POOLS[resourceId];
  if (!pool) return speaker;
  const speakerIsUranus = speaker.includes('_uranus_');
  const speakerIsBigtts = speaker.endsWith('_bigtts') && !speakerIsUranus;
  const resourceWantsUranus = resourceId === 'seed-tts-2.0';
  if (resourceWantsUranus !== speakerIsUranus) {
    // Only rewrite voices we positively identified as cross-family; leave
    // everything else (clone ids, future families) untouched.
    if (!speakerIsUranus && !speakerIsBigtts) return speaker;
    const mapped = pickPooledSpeaker(pool, speaker);
    console.warn(
      `[DoubaoTTS] 音色 ${speaker} 不在资源 ${resourceId} 的授权范围（55000000），已自动改用 ${mapped}`,
    );
    return mapped;
  }
  return speaker;
}
