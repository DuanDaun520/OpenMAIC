/**
 * buildProviderConfigImportRows — the env/YAML → `provider_configs` decision
 * table for the config-in-database import (POST /api/admin/providers/import and
 * the first-boot seed).
 *
 * Pure unit: a literal ServerConfig in, planned rows out. What is pinned here:
 * the section→capability renaming (providers→llm, webSearch→websearch), the
 * force-disable sets becoming enabled:false rows (and surviving even without
 * credentials), AliDocMind's AccessKey pair riding extraSecrets, field
 * normalization, and deterministic ordering.
 */
import { describe, expect, it } from 'vitest';

import type { ServerConfig } from '@/lib/server/provider-config';
import { buildProviderConfigImportRows } from '@/lib/server/provider-config-import';

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    providers: {},
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
    disabled: {
      tts: new Set<string>(),
      asr: new Set<string>(),
      image: new Set<string>(),
      video: new Set<string>(),
      webSearch: new Set<string>(),
    },
    ...overrides,
  };
}

describe('buildProviderConfigImportRows', () => {
  it('maps sections to admin capabilities and normalizes optional fields', () => {
    const rows = buildProviderConfigImportRows(
      makeConfig({
        providers: {
          openai: { apiKey: 'sk-1', baseUrl: undefined, models: ['gpt-5'], proxy: undefined },
        },
        webSearch: { tavily: { apiKey: 'tvly-1' } },
        pdf: { mineru: { apiKey: '', baseUrl: 'https://mineru.example' } },
      }),
    );

    expect(rows).toEqual([
      // Sorted by capability: image < llm < pdf < tts < video < websearch.
      {
        capability: 'llm',
        providerId: 'openai',
        apiKey: 'sk-1',
        extraSecrets: {},
        baseUrl: null,
        models: ['gpt-5'],
        proxy: null,
        enabled: true,
      },
      {
        capability: 'pdf',
        providerId: 'mineru',
        apiKey: '',
        extraSecrets: {},
        baseUrl: 'https://mineru.example',
        models: [],
        proxy: null,
        enabled: true,
      },
      {
        capability: 'websearch',
        providerId: 'tavily',
        apiKey: 'tvly-1',
        extraSecrets: {},
        baseUrl: null,
        models: [],
        proxy: null,
        enabled: true,
      },
    ]);
  });

  it('imports a force-disabled configured provider as enabled:false, keeping its credentials', () => {
    const rows = buildProviderConfigImportRows(
      makeConfig({
        tts: { 'glm-tts': { apiKey: 'glm-key' } },
        disabled: {
          ...makeConfig().disabled,
          tts: new Set(['glm-tts']),
        },
      }),
    );

    expect(rows).toEqual([
      {
        capability: 'tts',
        providerId: 'glm-tts',
        apiKey: 'glm-key',
        extraSecrets: {},
        baseUrl: null,
        models: [],
        proxy: null,
        // The overlay re-applies this to the disabled set — same fleet-wide
        // force-off the yml `enabled: false` / *_ENABLED env produced.
        enabled: false,
      },
    ]);
  });

  it('emits a bare enabled:false row for a force-disable with no credentials', () => {
    // A keyless force-off (e.g. browser-native-tts) never lands in a section —
    // the loader activates on key/baseUrl — but the disable must survive the
    // config file's removal.
    const rows = buildProviderConfigImportRows(
      makeConfig({
        disabled: {
          ...makeConfig().disabled,
          tts: new Set(['browser-native-tts']),
        },
      }),
    );

    expect(rows).toEqual([
      {
        capability: 'tts',
        providerId: 'browser-native-tts',
        apiKey: '',
        extraSecrets: {},
        baseUrl: null,
        models: [],
        proxy: null,
        enabled: false,
      },
    ]);
  });

  it("imports AliDocMind's AccessKey pair into extraSecrets", () => {
    const rows = buildProviderConfigImportRows(
      makeConfig({
        pdf: {
          alidocmind: {
            apiKey: '',
            accessKeyId: 'ak-1',
            accessKeySecret: 'sk-1',
            baseUrl: 'https://docmind.example',
          },
        },
      }),
    );

    expect(rows).toEqual([
      {
        capability: 'pdf',
        providerId: 'alidocmind',
        apiKey: '',
        // The AK/SK pair has no dedicated columns; it rides the encrypted
        // extra_secrets map so the provider imports completely — no env residue.
        extraSecrets: { accessKeyId: 'ak-1', accessKeySecret: 'sk-1' },
        baseUrl: 'https://docmind.example',
        models: [],
        proxy: null,
        enabled: true,
      },
    ]);
  });

  it('orders rows by capability then providerId regardless of section iteration order', () => {
    const rows = buildProviderConfigImportRows(
      makeConfig({
        video: { zeta: { apiKey: 'z' }, alpha: { apiKey: 'a' } },
        asr: { 'funasr-asr': { apiKey: '', baseUrl: 'http://localhost' } },
        tts: { 'openai-tts': { apiKey: 'k' } },
      }),
    );

    expect(rows.map((row) => `${row.capability}/${row.providerId}`)).toEqual([
      'asr/funasr-asr',
      'tts/openai-tts',
      'video/alpha',
      'video/zeta',
    ]);
  });
});
