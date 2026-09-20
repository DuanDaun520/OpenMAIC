import { describe, it, expect } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
};

// The copy the settings Skills section renders through `t('settings.skills.*')`.
const KEYS = [
  'settings.skills.nav',
  'settings.skills.title',
  'settings.skills.description',
  'settings.skills.mySkills',
  'settings.skills.builtinSkills',
  'settings.skills.emptyMySkills',
  'settings.skills.emptyBuiltinSkills',
  'settings.skills.listFailed',
  'settings.skills.retry',
  'settings.skills.badgeBuiltin',
  'settings.skills.badgeOwner',
  'settings.skills.badgeConstraints',
  'settings.skills.details',
  'settings.skills.download',
  'settings.skills.detailFailed',
  'settings.skills.contentLabel',
  'settings.skills.builtinDetailNote',
  'settings.skills.upload',
  'settings.skills.uploading',
  'settings.skills.uploadFailed',
  'settings.skills.delete',
  'settings.skills.deleting',
  'settings.skills.deleteTitle',
  'settings.skills.deleteConfirm',
  'settings.skills.deleteFailed',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- locale JSON traversal
const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);

describe('skill settings locale coverage', () => {
  it('every key exists, is non-empty, and does not echo the key, in all 12 locales', () => {
    for (const [code, data] of Object.entries(locales)) {
      for (const k of KEYS) {
        const v = get(data, k);
        expect(typeof v, `${code} missing ${k}`).toBe('string');
        expect((v as string).trim(), `${code} empty ${k}`).not.toBe('');
        expect(v, `${code} echoes ${k}`).not.toBe(k);
      }
    }
  });
});
