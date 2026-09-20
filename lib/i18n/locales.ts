export type LocaleEntry = {
  code: string;
  /** Native name shown in dropdown, e.g. '简体中文' */
  label: string;
  /** Short label shown on the toggle button, e.g. 'CN' */
  shortLabel: string;
};

/**
 * Supported locales registry.
 *
 * The UI ships exactly two languages — Simplified Chinese (default) and
 * English. A browser holding any other stored/detected language resolves to
 * the default in `use-i18n.tsx`, and i18next's `supportedLngs` (built from
 * this list) never tries to load another JSON bundle.
 *
 * To add a new language:
 *   1. Create `lib/i18n/locales/<code>.json` (copy an existing file as template)
 *   2. Add an entry here
 */
export const supportedLocales = [
  { code: 'zh-CN', label: '简体中文', shortLabel: 'CN' },
  { code: 'en-US', label: 'English', shortLabel: 'EN' },
] as const satisfies readonly LocaleEntry[];
