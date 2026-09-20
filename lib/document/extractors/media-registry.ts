import { getMediaExtractorManifestEntries, type MediaExtractorManifestEntry } from './manifest';
import type {
  MediaExtractorInput,
  MediaExtractorProvider,
  MediaExtractorProviderId,
} from '../types';

// Metadata-only until first use: provider selection needs only the
// browser-safe manifest entries, while the implementation modules — which pull
// in `child_process`, the ASR clients and `@alicloud/*` — load when an
// availability check or extraction actually runs. Routes that reach this
// registry but never extract media stay free of that weight.
//
// Dispatch stays provider-neutral: the array-exporting implementation module
// serves the service-backed entries, and the single-provider module is the
// fallback. This file deliberately names no concrete provider id (the
// provider-neutrality guard pins this surface by occurrence count).
let cloudBackedProviders: Promise<MediaExtractorProvider[]> | null = null;
function loadCloudBackedProviders() {
  cloudBackedProviders ??= import('./media').then((m) => m.mediaBackedExtractorProviders);
  return cloudBackedProviders;
}

let diskBackedProvider: Promise<MediaExtractorProvider> | null = null;
function loadDiskBackedProvider() {
  diskBackedProvider ??= import('./local-media').then((m) => m.localMediaExtractorProvider);
  return diskBackedProvider;
}

async function resolveImplementation(id: MediaExtractorProviderId) {
  const found = (await loadCloudBackedProviders()).find((p) => p.id === id);
  if (found) return found;
  const fallback = await loadDiskBackedProvider();
  if (fallback.id !== id) {
    throw new Error(`Media extractor "${id}" failed to load`);
  }
  return fallback;
}

function createLazyMediaExtractor(entry: MediaExtractorManifestEntry): MediaExtractorProvider {
  // The manifest is the single source of provider identity (RFC #1153 part 1);
  // its declared ids are exactly this registry's known ids.
  const id = entry.id as MediaExtractorProviderId;
  const { id: _id, ...metadata } = entry;
  return {
    ...metadata,
    id,
    async availability(input: MediaExtractorInput) {
      const provider = await resolveImplementation(id);
      // A provider without an availability check is unconditionally available
      // (the optional method already means that in `selectMediaExtractorProvider`).
      return (await provider.availability?.(input)) ?? { available: true };
    },
    async extract(input: MediaExtractorInput) {
      const provider = await resolveImplementation(id);
      return provider.extract(input);
    },
  };
}

// Manifest insertion order IS the auto-selection order and matches the
// registry order this file used to build eagerly.
const MEDIA_EXTRACTOR_PROVIDERS: Record<MediaExtractorProviderId, MediaExtractorProvider> =
  Object.fromEntries(
    getMediaExtractorManifestEntries().map((entry) => [entry.id, createLazyMediaExtractor(entry)]),
  );

export function getMediaExtractorProviders(): MediaExtractorProvider[] {
  return Object.values(MEDIA_EXTRACTOR_PROVIDERS);
}

export function getMediaExtractorProvider(
  providerId: MediaExtractorProviderId,
): MediaExtractorProvider | undefined {
  return MEDIA_EXTRACTOR_PROVIDERS[providerId];
}

export async function selectMediaExtractorProvider(options: {
  mimeType: string;
  preferredProviderId?: MediaExtractorProviderId;
  requiredCapabilities?: Partial<MediaExtractorProvider['capabilities']>;
  input: MediaExtractorInput;
  providers?: MediaExtractorProvider[];
}): Promise<MediaExtractorProvider> {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (provider: MediaExtractorProvider) =>
    provider.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required ||
        provider.capabilities[capability as keyof MediaExtractorProvider['capabilities']],
    );

  const providers = options.providers ?? getMediaExtractorProviders();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const availabilityReason = async (provider: MediaExtractorProvider) => {
    const availability = await provider.availability?.(options.input);
    return availability && !availability.available
      ? (availability.reason ?? 'unavailable')
      : undefined;
  };

  if (options.preferredProviderId) {
    const preferred = providerById.get(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown media extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Media extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    const reason = await availabilityReason(preferred);
    if (reason) {
      throw new Error(`Media extractor "${preferred.id}" is unavailable: ${reason}`);
    }
    return preferred;
  }

  const supported = providers.filter(supportsRequest);
  for (const provider of supported) {
    if (!(await availabilityReason(provider))) return provider;
  }
  throw new Error(
    `Media extraction is unavailable for "${options.mimeType}". Configure AliDocMind credentials for cloud extraction, or install ffmpeg (including ffprobe) and configure a server ASR provider for local extraction.`,
  );
}
