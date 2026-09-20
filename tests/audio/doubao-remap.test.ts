/**
 * Doubao cross-family speaker remapping.
 *
 * The regression this guards: a female-labeled selection (知性灿灿 / 爽快思思
 * — uranus voices) under a 大模型语音合成 grant (volc.service_type.10029)
 * was hashed into a pool containing a male voice and came back as 北京小夜 —
 * name/avatar female, audio male. The replacement must preserve the source
 * speaker's declared gender (and language when the pool allows).
 */
import { describe, it, expect } from 'vitest';

import {
  DOUBAO_RESOURCE_VOICE_POOLS,
  parseSpeakerTraits,
  pickPooledSpeaker,
  remapDoubaoSpeaker,
} from '@/lib/audio/doubao-remap';

const SEED_POOL = DOUBAO_RESOURCE_VOICE_POOLS['seed-tts-2.0'];
const MOON_POOL = DOUBAO_RESOURCE_VOICE_POOLS['volc.service_type.10029'];

describe('parseSpeakerTraits', () => {
  it('reads the zh/en + male/female prefix', () => {
    expect(parseSpeakerTraits('zh_female_cancan_uranus_bigtts')).toEqual({
      language: 'zh',
      gender: 'female',
    });
    expect(parseSpeakerTraits('en_male_tim_uranus_bigtts')).toEqual({
      language: 'en',
      gender: 'male',
    });
  });

  it('returns undefined for clone ids and unknown shapes', () => {
    expect(parseSpeakerTraits('S_x7default')).toBeUndefined();
    expect(parseSpeakerTraits('voice_volc')).toBeUndefined();
  });
});

describe('pickPooledSpeaker', () => {
  it('never swaps gender when the pool has a same-gender voice', () => {
    expect(
      pickPooledSpeaker(MOON_POOL, 'zh_female_cancan_uranus_bigtts').startsWith('zh_female_'),
    ).toBe(true);
    expect(
      pickPooledSpeaker(MOON_POOL, 'zh_male_liufei_uranus_bigtts').startsWith('zh_male_'),
    ).toBe(true);
  });

  it('prefers same language+gender, falling back to same gender', () => {
    // Seed pool has zh+en females: a zh female source must land on a zh female.
    const female = pickPooledSpeaker(SEED_POOL, 'zh_female_shuangkuaisisi_moon_bigtts');
    expect(['zh_female_vv_uranus_bigtts', 'zh_female_xiaohe_uranus_bigtts']).toContain(female);
    // No en male beyond tim himself → same-gender fallback still male.
    expect(pickPooledSpeaker(SEED_POOL, 'zh_male_taocheng_uranus_bigtts')).toBe(
      'zh_male_m191_uranus_bigtts',
    );
  });

  it('is deterministic per source voice', () => {
    expect(pickPooledSpeaker(MOON_POOL, 'zh_female_cancan_uranus_bigtts')).toBe(
      pickPooledSpeaker(MOON_POOL, 'zh_female_cancan_uranus_bigtts'),
    );
  });
});

describe('remapDoubaoSpeaker', () => {
  it('the reported bug: female uranus voices under a 10029 grant stay female', () => {
    // 知性灿灿 2.0 / 爽快思思 2.0 — both previously remapped to the male
    // 北京小夜 by the raw hash.
    expect(remapDoubaoSpeaker('volc.service_type.10029', 'zh_female_cancan_uranus_bigtts')).toBe(
      'zh_female_shuangkuaisisi_moon_bigtts',
    );
    expect(
      remapDoubaoSpeaker('volc.service_type.10029', 'zh_female_shuangkuaisisi_uranus_bigtts'),
    ).toBe('zh_female_shuangkuaisisi_moon_bigtts');
  });

  it('male uranus voices under a 10029 grant stay male', () => {
    expect(remapDoubaoSpeaker('volc.service_type.10029', 'zh_male_m191_uranus_bigtts')).toBe(
      'zh_male_beijingxiaoye_emo_v2_mars_bigtts',
    );
  });

  it('in-family speakers pass through untouched', () => {
    expect(
      remapDoubaoSpeaker('volc.service_type.10029', 'zh_female_shuangkuaisisi_moon_bigtts'),
    ).toBe('zh_female_shuangkuaisisi_moon_bigtts');
    expect(remapDoubaoSpeaker('seed-tts-2.0', 'zh_female_cancan_uranus_bigtts')).toBe(
      'zh_female_cancan_uranus_bigtts',
    );
  });

  it('leaves clone ids and unknown resources alone', () => {
    expect(remapDoubaoSpeaker('volc.service_type.10029', 'S_clone123abc')).toBe('S_clone123abc');
    expect(remapDoubaoSpeaker('volc.future.9', 'zh_female_cancan_uranus_bigtts')).toBe(
      'zh_female_cancan_uranus_bigtts',
    );
  });
});
