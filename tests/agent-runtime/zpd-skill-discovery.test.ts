import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listSkills } from '@/lib/server/agent-runtime/skills';
import { supportedLocales } from '@/lib/i18n/locales';
import { createWorkbenchTranslator, workbenchResourceFor } from '@/lib/i18n/workbench';
import { skillTitle } from '@/lib/workbench/agent-skills';

describe('exercise lesson skill discovery', () => {
  it('keeps the stable invocation id and exposes the Chinese title and references', async () => {
    const skill = (await listSkills()).find((entry) => entry.id === 'zone-of-proximal-development');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('zone-of-proximal-development');
    expect(skill!.title).toBe('习题课（最近发展区）');
    expect(skill!.source).toBe('builtin');

    for (const reference of ['exercise-lesson.md', 'theory.md']) {
      expect(existsSync(join(dirname(skill!.filePath), 'references', reference))).toBe(true);
    }
  });

  it.each(supportedLocales)('has explicit workbench display copy for $code', ({ code }) => {
    const handle = 'zone-of-proximal-development';
    // Both shipped locales are written in full in workbench.ts — no overlay
    // files to fall back through, so the merged resource IS the locale's copy.
    const resource = workbenchResourceFor(code) as { skill?: { title?: Record<string, string> } };
    const localized = resource.skill?.title?.[handle];

    expect(typeof localized).toBe('string');
    expect(localized?.trim()).not.toBe('');
    expect(skillTitle({ name: handle, source: 'builtin' }, createWorkbenchTranslator(code))).toBe(
      localized,
    );
    if (code === 'zh-CN') expect(localized).toBe('习题课（最近发展区）');
    if (code === 'en-US') expect(localized).toBe('Practice lesson (zone of proximal development)');
  });
});
