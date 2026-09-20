/**
 * SerpBase Web Search Integration
 *
 * Uses raw REST API via proxyFetch for reliable proxy support.
 * SerpBase search endpoint: POST https://api.serpbase.dev/google/search
 * Auth: X-API-Key header. Docs: https://serpbase.dev/docs
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const SERPBASE_DEFAULT_BASE_URL = 'https://api.serpbase.dev';

const SERPBASE_MAX_QUERY_LENGTH = 400;

function buildSerpbaseSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || SERPBASE_DEFAULT_BASE_URL).replace(/\/$/, '');
  return trimmed.endsWith('/google/search') ? trimmed : `${trimmed}/google/search`;
}

/** Route CJK queries to Chinese Google locales; leave the API defaults otherwise. */
function buildLocaleParams(query: string): { hl: string; gl: string } | Record<string, never> {
  const hasCJK = /[一-鿿㐀-䶿]/.test(query);
  return hasCJK ? { hl: 'zh-CN', gl: 'cn' } : {};
}

interface SerpbaseOrganicResult {
  rank?: number;
  title: string;
  link: string;
  url?: string;
  snippet?: string;
}

/**
 * Search the web using the SerpBase Google SERP API and return structured results.
 */
export async function searchWithSerpbase(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 5, baseUrl, signal } = params;

  const truncatedQuery = query.slice(0, SERPBASE_MAX_QUERY_LENGTH);

  const res = await proxyFetch(buildSerpbaseSearchUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      q: truncatedQuery,
      page: 1,
      device: 'default',
      ...buildLocaleParams(truncatedQuery),
    }),
    ...(signal ? { signal } : {}),
  });

  const data = (await res.json().catch(() => undefined)) as
    | {
        status?: number;
        error?: string;
        query?: string;
        elapsed_ms?: number;
        organic?: SerpbaseOrganicResult[];
        featured_snippet?: { text?: string; snippet?: string; answer?: string } | string;
      }
    | undefined;

  // SerpBase answers errors with a JSON envelope (status != 0) even on HTTP 200.
  if (!res.ok || !data || (typeof data.status === 'number' && data.status !== 0)) {
    const detail = data?.error || `${res.status} ${res.statusText}`.trim() || 'unknown error';
    throw new Error(`SerpBase API error: ${detail}`);
  }

  const sources: WebSearchSource[] = (data.organic || []).slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url || r.link,
    content: r.snippet || '',
    // SerpBase has no relevance score; derive a gentle rank-based decay so
    // downstream consumers can still order/prioritize sources.
    score: Math.max(0.1, 1 - ((r.rank || 1) - 1) * 0.1),
  }));

  const featuredSnippet = data.featured_snippet;
  const answer =
    typeof featuredSnippet === 'string'
      ? featuredSnippet
      : featuredSnippet?.text || featuredSnippet?.snippet || featuredSnippet?.answer || '';

  return {
    answer,
    sources,
    query: data.query || truncatedQuery,
    responseTime: (data.elapsed_ms || 0) / 1000,
  };
}
