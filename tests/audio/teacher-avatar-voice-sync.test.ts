/**
 * Teacher-avatar ↔ narration-voice gender sync.
 *
 * inferVoiceGender is the pure core (catalog metadata, then id/design-text
 * heuristics with 'female' checked before 'male' — 'female' contains 'male');
 * syncDefaultTeacherAvatarToVoice is the registry side effect, tested against
 * a real registry seeded with the DEFAULT_AGENTS and a stubbed settings store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// agent-voice pulls browser-only deps transitively (IndexedDB); stub them so
// the sync logic is unit-testable in node (same pattern as agent-voice.test).
vi.mock('@/lib/audio/voxcpm-voices', () => ({ getVoxCPMProviderOptions: vi.fn() }));

const settingsState: {
  ttsProviderId: string;
  ttsVoice: string;
  ttsProvidersConfig: Record<string, Record<string, unknown>>;
} = {
  ttsProviderId: 'browser-native-tts',
  ttsVoice: 'default',
  ttsProvidersConfig: {},
};

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => settingsState,
    subscribe: () => () => undefined,
  },
}));

const localStorageStub = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

import {
  TEACHER_AVATAR_FEMALE,
  TEACHER_AVATAR_MALE,
  inferVoiceGender,
  syncDefaultTeacherAvatarToVoice,
} from '@/lib/orchestration/registry/teacher-avatar';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';

beforeEach(() => {
  settingsState.ttsProviderId = 'browser-native-tts';
  settingsState.ttsVoice = 'default';
  settingsState.ttsProvidersConfig = {};
});

describe('inferVoiceGender', () => {
  it('uses the provider catalog metadata first', () => {
    expect(inferVoiceGender('azure-tts', 'zh-CN-XiaoxiaoNeural')).toBe('female');
    expect(inferVoiceGender('azure-tts', 'zh-CN-YunxiNeural')).toBe('male');
  });

  it('falls back to the voice-id text, with female checked before male', () => {
    // 'zh_female_…' contains the substring 'male' — order decides.
    expect(inferVoiceGender('doubao-tts', 'zh_female_vv_uranus_bigtts')).toBe('female');
    expect(inferVoiceGender('doubao-tts', 'zh_male_beijingxiaoye_emo_v2_mars_bigtts')).toBe('male');
  });

  it('reads a voiceDesign identity like "middle-aged male teacher"', () => {
    expect(inferVoiceGender('voxcpm', 'voxcpm-auto', 'middle-aged male teacher')).toBe('male');
    expect(inferVoiceGender('voxcpm', 'voxcpm-auto', 'young female student')).toBe('female');
    expect(inferVoiceGender('voxcpm', 'voxcpm-auto', '女老师，温和')).toBe('female');
    expect(inferVoiceGender('voxcpm', 'voxcpm-auto', '男教师')).toBe('male');
  });

  it('returns undefined when nothing gendered can be inferred', () => {
    expect(inferVoiceGender('openai-tts', 'marin')).toBeUndefined();
    expect(inferVoiceGender('browser-native-tts', 'default')).toBeUndefined();
  });
});

describe('syncDefaultTeacherAvatarToVoice', () => {
  it('swaps the default teacher to the female portrait for a female voice', () => {
    settingsState.ttsProviderId = 'azure-tts';
    settingsState.ttsVoice = 'zh-CN-XiaoxiaoNeural';

    syncDefaultTeacherAvatarToVoice();

    expect(useAgentRegistry.getState().agents['default-1'].avatar).toBe(TEACHER_AVATAR_FEMALE);
  });

  it('swaps back to the male portrait for a male voice', () => {
    useAgentRegistry.getState().updateAgent('default-1', { avatar: TEACHER_AVATAR_FEMALE });
    settingsState.ttsProviderId = 'azure-tts';
    settingsState.ttsVoice = 'zh-CN-YunxiNeural';

    syncDefaultTeacherAvatarToVoice();

    expect(useAgentRegistry.getState().agents['default-1'].avatar).toBe(TEACHER_AVATAR_MALE);
  });

  it('leaves the avatar alone when the voice gender is unknown', () => {
    useAgentRegistry.getState().updateAgent('default-1', { avatar: TEACHER_AVATAR_FEMALE });
    // browser-native default — no gender signal.
    syncDefaultTeacherAvatarToVoice();

    expect(useAgentRegistry.getState().agents['default-1'].avatar).toBe(TEACHER_AVATAR_FEMALE);
  });
});
