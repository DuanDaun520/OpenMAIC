import { describe, expect, it } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

describe('edit_elements locale coverage', () => {
  it.each([enUS, zhCN])('defines the client apply-failure correction', (locale) => {
    expect(locale.edit.editElements.applyFailed).toBeTruthy();
    expect(locale.edit.editElements.applyPartiallyFailed).toBeTruthy();
  });

  it.each([enUS, zhCN])('defines renderer video toolbar labels', (locale) => {
    expect(locale.edit.video.toolbar).toBeTruthy();
    expect(locale.edit.video.poster).toBeTruthy();
    expect(locale.edit.insert.video).toBeTruthy();
    expect(locale.edit.insert.videoDrop).toBeTruthy();
    expect(locale.edit.insert.videoOr).toBeTruthy();
    expect(locale.edit.insert.videoUrlPlaceholder).toBeTruthy();
    expect(locale.edit.insert.videoInsert).toBeTruthy();
  });

  it.each([enUS, zhCN])('defines renderer audio toolbar and insert labels', (locale) => {
    expect(locale.edit.audio.toolbar).toBeTruthy();
    expect(locale.edit.audio.preview).toBeTruthy();
    expect(locale.edit.audio.pause).toBeTruthy();
    expect(locale.edit.audio.loop).toBeTruthy();
    expect(locale.edit.insert.audio).toBeTruthy();
    expect(locale.edit.insert.audioDrop).toBeTruthy();
    expect(locale.edit.insert.audioOr).toBeTruthy();
    expect(locale.edit.insert.audioUrlPlaceholder).toBeTruthy();
    expect(locale.edit.insert.audioInsert).toBeTruthy();
  });
});
