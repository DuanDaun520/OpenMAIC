import { textDocumentExtractorProvider } from './text';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { getDocumentExtractorManifestEntry } from './manifest';
import type { DocumentExtractorProvider, DocumentExtractorProviderId } from '../types';

// Metadata-only until first use: provider selection needs only the
// browser-safe manifest entry, while the implementation module — which
// transitively imports native `sharp`, `unpdf` and the MinerU/AliDocMind
// clients — loads when an extraction actually runs. This keeps the cold start
// of every route that reaches this registry (extract-document, parse-pdf)
// free of that weight.
let pdfProviders: Promise<DocumentExtractorProvider[]> | null = null;
function loadPdfProviders() {
  pdfProviders ??= import('./pdf').then((m) => m.pdfDocumentExtractorProviders);
  return pdfProviders;
}

/**
 * The manifest entry backing a PDF provider, or a loud failure at module init
 * (mirrors the eager check `./pdf` used to run at its own import).
 */
function pdfManifestEntry(id: DocumentExtractorProviderId) {
  const entry = getDocumentExtractorManifestEntry(id);
  if (!entry) {
    throw new Error(`No document extractor manifest entry for PDF provider "${id}"`);
  }
  return entry;
}

function createLazyPdfBackedDocumentExtractor(
  id: DocumentExtractorProviderId,
): DocumentExtractorProvider {
  return {
    // Metadata comes from the browser-safe manifest — single source of truth
    // for the extractor identity (RFC #1153 part 1); the implementation is
    // attached lazily so importing the registry costs nothing heavy.
    ...pdfManifestEntry(id),
    async extract(input) {
      const provider = (await loadPdfProviders()).find((p) => p.id === id);
      if (!provider) {
        throw new Error(`PDF extractor "${id}" failed to load`);
      }
      return provider.extract(input);
    },
  };
}

const documentExtractorProviders = [
  textDocumentExtractorProvider, // pure TS — stays static
  ...Object.keys(PDF_PROVIDERS).map((id) =>
    createLazyPdfBackedDocumentExtractor(id as DocumentExtractorProviderId),
  ),
];

const DOCUMENT_EXTRACTOR_PROVIDERS: Record<DocumentExtractorProviderId, DocumentExtractorProvider> =
  Object.fromEntries(documentExtractorProviders.map((provider) => [provider.id, provider]));

export function getDocumentExtractorProviders(): DocumentExtractorProvider[] {
  return Object.values(DOCUMENT_EXTRACTOR_PROVIDERS);
}

export function getDocumentExtractorProvider(
  providerId: DocumentExtractorProviderId,
): DocumentExtractorProvider | undefined {
  return DOCUMENT_EXTRACTOR_PROVIDERS[providerId];
}

export function selectDocumentExtractorProvider(options: {
  mimeType: string;
  preferredProviderId?: DocumentExtractorProviderId;
  requiredCapabilities?: Partial<DocumentExtractorProvider['capabilities']>;
}): DocumentExtractorProvider {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (provider: DocumentExtractorProvider) =>
    provider.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required ||
        provider.capabilities[capability as keyof DocumentExtractorProvider['capabilities']],
    );

  if (options.preferredProviderId) {
    const preferred = getDocumentExtractorProvider(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown document extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Document extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    return preferred;
  }

  const provider = getDocumentExtractorProviders().find(supportsRequest);
  if (!provider) {
    throw new Error(
      `No document extractor supports MIME type "${options.mimeType}" with the requested capabilities`,
    );
  }
  return provider;
}
