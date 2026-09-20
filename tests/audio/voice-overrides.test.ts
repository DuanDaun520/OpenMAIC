/**
 * Admin voice-override merging — the pure rules plus their integration with
 * the client resolver cache (rename / re-gender / hide / custom addition).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { applyVoiceOverrides, type VoiceOverride } from '@/lib/audio/voice-override-rules';
import {
  getClientVoiceOverrides,
  setClientVoiceOverrides,
} from '@/lib/audio/voice-overrides-client';
import { findVoiceDisplayName, getEnabledProvidersWithVoices } from '@/lib/audio/voice-resolver';

const PRESETS = [
  {
    id: 'zh_female_cancan_uranus_bigtts',
    name: '知性灿灿 2.0',
    language: 'zh-CN',
    gender: 'female',
  },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0', language: 'zh-CN', gender: 'male' },
] as const;

function override(partial: Partial<VoiceOverride>): VoiceOverride {
  return {
    providerId: 'doubao-tts',
    voiceId: 'zh_female_cancan_uranus_bigtts',
    name: null,
    language: null,
    gender: null,
    description: null,
    hidden: false,
    sortOrder: 0,
    ...partial,
  };
}

beforeEach(() => {
  setClientVoiceOverrides([]);
});

describe('applyVoiceOverrides', () => {
  it('returns presets untouched for an empty overlay', () => {
    expect(applyVoiceOverrides([...PRESETS], [])).toEqual([...PRESETS]);
  });

  it('renames and re-genders a preset, leaving null fields alone', () => {
    const merged = applyVoiceOverrides(
      [...PRESETS],
      [override({ name: '灿灿（改正版）', gender: 'neutral' })],
    );
    expect(merged[0]).toMatchObject({
      id: 'zh_female_cancan_uranus_bigtts',
      name: '灿灿（改正版）',
      gender: 'neutral',
      language: 'zh-CN',
    });
    expect(merged[1].name).toBe('云舟 2.0');
  });

  it('drops hidden presets', () => {
    const merged = applyVoiceOverrides([...PRESETS], [override({ hidden: true })]);
    expect(merged.map((voice) => voice.id)).toEqual(['zh_male_m191_uranus_bigtts']);
  });

  it('appends non-preset rows as additions in sortOrder order', () => {
    const merged = applyVoiceOverrides(
      [...PRESETS],
      [
        override({ voiceId: 'zh_female_new_moon_bigtts', name: '新音色', sortOrder: 2 }),
        override({ voiceId: 'zh_female_first_moon_bigtts', name: '更靠前', sortOrder: 1 }),
      ],
    );
    expect(merged.map((voice) => voice.id)).toEqual([
      'zh_female_cancan_uranus_bigtts',
      'zh_male_m191_uranus_bigtts',
      'zh_female_first_moon_bigtts',
      'zh_female_new_moon_bigtts',
    ]);
    expect(merged[2]).toMatchObject({ name: '更靠前' });
  });

  it('drops hidden additions entirely', () => {
    const merged = applyVoiceOverrides(
      [...PRESETS],
      [override({ voiceId: 'custom_x', name: 'X', hidden: true })],
    );
    expect(merged).toHaveLength(2);
  });
});

describe('getEnabledProvidersWithVoices × overlay cache', () => {
  // doubao-tts is requiresApiKey; a config with an apiKey marks it enabled.
  const providerConfigs = {
    'doubao-tts': { apiKey: 'app:key' },
  } as unknown as Parameters<typeof getEnabledProvidersWithVoices>[0];

  function doubaoVoices() {
    return getEnabledProvidersWithVoices(providerConfigs).find(
      (provider) => provider.providerId === 'doubao-tts',
    )?.voices;
  }

  it('applies the cached overlay to the advertised voice list', () => {
    setClientVoiceOverrides([
      override({ name: '灿灿（改正版）' }),
      override({ voiceId: 'zh_female_tianmeixiaoyuan_uranus_bigtts', hidden: true }),
      override({ voiceId: 'zh_female_extra_moon_bigtts', name: '追加音色' }),
    ]);

    const voices = doubaoVoices() ?? [];
    expect(voices.find((voice) => voice.id === 'zh_female_cancan_uranus_bigtts')?.name).toBe(
      '灿灿（改正版）',
    );
    expect(voices.some((voice) => voice.id === 'zh_female_tianmeixiaoyuan_uranus_bigtts')).toBe(
      false,
    );
    expect(voices.some((voice) => voice.id === 'zh_female_extra_moon_bigtts')).toBe(true);
  });

  it('findVoiceDisplayName honors the rename', () => {
    expect(findVoiceDisplayName('doubao-tts', 'zh_female_cancan_uranus_bigtts')).toBe(
      '知性灿灿 2.0',
    );
    setClientVoiceOverrides([override({ name: '灿灿（改正版）' })]);
    expect(findVoiceDisplayName('doubao-tts', 'zh_female_cancan_uranus_bigtts')).toBe(
      '灿灿（改正版）',
    );
  });

  it('the cache read is what tests and clients share', () => {
    setClientVoiceOverrides([override({ name: 'X' })]);
    expect(getClientVoiceOverrides()).toHaveLength(1);
  });
});
