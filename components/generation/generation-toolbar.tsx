'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { Paperclip, FileText, X, Globe2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderConfig } from '@/lib/pdf/types';
import { WEB_SEARCH_PROVIDERS, isWebSearchProviderConfigured } from '@/lib/web-search/constants';
import { getAcceptStringForProviders, isMimeSupportedByProviders } from '@/lib/document/mime';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
} from '@/lib/document/bundle';
import { dedupeCourseMaterialFiles } from '@/lib/document/course-materials';
import type { SelectedCourseMaterial } from '@/lib/types/generation';

// ─── Constants ───────────────────────────────────────────────
const MAX_COURSE_MATERIAL_SIZE_MB = 50;
const MAX_COURSE_MATERIAL_SIZE_BYTES = MAX_COURSE_MATERIAL_SIZE_MB * 1024 * 1024;

// ─── PDF extractor auto-selection ────────────────────────────
// The upload popover no longer surfaces an extractor selector. A provider is
// usable when it needs no key (unpdf, self-hosted MinerU) or carries
// credentials / a server-side config — the same predicate the settings dialog
// applies to the same registry.
interface PDFProviderCredentials {
  apiKey?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  isServerConfigured?: boolean;
}

function isPDFProviderUsable(
  provider: PDFProviderConfig,
  cfg?: PDFProviderCredentials,
): boolean {
  if (!provider.requiresApiKey) return true;
  return (
    !!cfg?.isServerConfigured ||
    !!cfg?.apiKey ||
    (!!cfg?.accessKeyId && !!cfg?.accessKeySecret)
  );
}

/** True when the provider carries real setup beyond the keyless default. */
function hasExtractorCredentials(cfg?: PDFProviderCredentials): boolean {
  return (
    !!cfg?.isServerConfigured ||
    !!cfg?.apiKey ||
    (!!cfg?.accessKeyId && !!cfg?.accessKeySecret)
  );
}

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  webSearch: boolean;
  onWebSearchChange: (v: boolean) => void;
  // PDF
  courseMaterials: SelectedCourseMaterial[];
  onCourseMaterialsAdd: (files: File[]) => void;
  onCourseMaterialRemove: (id: string) => void;
  onPdfError: (error: string | null) => void;
  /**
   * When set, the course-material add/remove affordances and the web-search
   * toggle are all disabled (the parent freezes the material set and the
   * session inputs for the duration of generate-prep). The parent's handlers
   * are inert under the same flag; this only mirrors it in the UI.
   */
  materialsLocked?: boolean;
}

// ─── Component ───────────────────────────────────────────────
export function GenerationToolbar({
  webSearch,
  onWebSearchChange,
  courseMaterials,
  onCourseMaterialsAdd,
  onCourseMaterialRemove,
  onPdfError,
  materialsLocked = false,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((s) => s.pdfProvidersConfig);
  const setPDFProvider = useSettingsStore((s) => s.setPDFProvider);
  const webSearchProviderId = useSettingsStore((s) => s.webSearchProviderId);
  const webSearchProvidersConfig = useSettingsStore((s) => s.webSearchProvidersConfig);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Auto-select a workable extractor (no selector is shown anymore): keep the
  // remembered provider when it is usable; otherwise adopt the best workable
  // one — server-hosted or credentialed parsers first, then the keyless
  // fallback. unpdf needs no key, so a usable provider always exists and the
  // effect settles on the first run.
  useEffect(() => {
    if (isPDFProviderUsable(PDF_PROVIDERS[pdfProviderId], pdfProvidersConfig[pdfProviderId]))
      return;
    const registry = Object.values(PDF_PROVIDERS);
    const fallback =
      registry.find(
        (provider) =>
          isPDFProviderUsable(provider, pdfProvidersConfig[provider.id]) &&
          hasExtractorCredentials(pdfProvidersConfig[provider.id]),
      ) ??
      registry.find((provider) =>
        isPDFProviderUsable(provider, pdfProvidersConfig[provider.id]),
      );
    if (fallback) setPDFProvider(fallback.id);
  }, [pdfProviderId, pdfProvidersConfig, setPDFProvider]);

  // Check web search availability. Keyless providers such as Brave should keep
  // the toolbar reachable even when the current API-key provider is not ready.
  const webSearchProvider = WEB_SEARCH_PROVIDERS[webSearchProviderId];
  const webSearchConfig = webSearchProvidersConfig[webSearchProviderId];
  const selectedWebSearchAvailable = webSearchProvider
    ? isWebSearchProviderConfigured(webSearchProvider, webSearchConfig)
    : false;
  const webSearchAvailable = Object.values(WEB_SEARCH_PROVIDERS).some((provider) =>
    isWebSearchProviderConfigured(provider, webSearchProvidersConfig[provider.id]),
  );

  // Course material handler. `plain-text` is always active alongside the
  // user-selected extractor so txt/md files remain uploadable without
  // configuring an external service.
  const activeDocumentProviderIds = useMemo(
    () => [pdfProviderId, 'plain-text'] as const,
    [pdfProviderId],
  );
  const acceptForCurrentProvider = useMemo(
    () => getAcceptStringForProviders(activeDocumentProviderIds),
    [activeDocumentProviderIds],
  );

  // If the user switches to a provider that doesn't support already attached
  // materials, drop only the incompatible files so the eventual extraction
  // request matches the current provider capability.
  useEffect(() => {
    const unsupportedMaterials = courseMaterials.filter(
      (file) =>
        !isMimeSupportedByProviders(
          { mimeType: file.type, fileName: file.name },
          activeDocumentProviderIds,
        ),
    );
    if (unsupportedMaterials.length === 0) return;

    for (const file of unsupportedMaterials) {
      onCourseMaterialRemove(file.id);
    }
    onPdfError(t('upload.unsupportedCourseMaterial'));
    // Intentionally omit callbacks/t from deps: adding them would re-run this
    // provider capability cleanup on unrelated parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentProviderIds, courseMaterials]);

  const handleFilesSelect = (incomingFiles: File[]) => {
    // Belt-and-braces mirror of the parent's freeze guard: while generate-prep
    // is running the material set must not change, whatever the UI state says.
    if (materialsLocked) return;
    const supportedFiles = incomingFiles.filter((file) =>
      isMimeSupportedByProviders(
        { mimeType: file.type, fileName: file.name },
        activeDocumentProviderIds,
      ),
    );
    if (supportedFiles.length === 0) {
      onPdfError(t('upload.unsupportedCourseMaterial'));
      return;
    }
    if (supportedFiles.length !== incomingFiles.length) {
      onPdfError(t('upload.unsupportedCourseMaterial'));
      return;
    }
    if (supportedFiles.some((file) => file.size > MAX_COURSE_MATERIAL_SIZE_BYTES)) {
      onPdfError(t('upload.fileTooLarge'));
      return;
    }

    const dedupedFiles = dedupeCourseMaterialFiles(courseMaterials, supportedFiles);
    if (dedupedFiles.length === 0) return;

    if (courseMaterials.length + dedupedFiles.length > MAX_DOCUMENT_BUNDLE_FILES) {
      onPdfError(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
      return;
    }

    const totalSize =
      courseMaterials.reduce((sum, file) => sum + file.size, 0) +
      dedupedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
      onPdfError(
        t('upload.courseMaterialTotalSizeLimit', {
          n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
        }),
      );
      return;
    }

    onPdfError(null);
    onCourseMaterialsAdd(dedupedFiles);
  };

  // ─── Pill button helper ─────────────────────────────
  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';
  const pillMuted = `${pillCls} border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60`;
  const pillActive = `${pillCls} border-violet-200/60 dark:border-violet-700/50 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300`;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <div className="flex min-w-0 items-center gap-1">
        {/* ── Course material (extractor + upload) combined Popover ── */}
        <Popover>
          <PopoverTrigger asChild>
            {courseMaterials.length > 0 ? (
              <button className={pillActive}>
                <Paperclip className="size-3.5" />
                <span className="max-w-[140px] truncate">
                  {courseMaterials.length === 1
                    ? courseMaterials[0].name
                    : t('toolbar.courseMaterialsSelected', { n: courseMaterials.length })}
                </span>
              </button>
            ) : (
              <button className={pillMuted}>
                <Paperclip className="size-3.5" />
              </button>
            )}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            {/* Upload area / file info */}
            <div className="px-3 py-3">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept={acceptForCurrentProvider}
                multiple
                disabled={materialsLocked}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) handleFilesSelect(files);
                  e.target.value = '';
                }}
              />
              <div className="space-y-3">
                <div
                  className={cn(
                    'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors',
                    isDragging
                      ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
                      : 'border-muted-foreground/20 hover:border-violet-300',
                    materialsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                  )}
                  onClick={() => {
                    if (!materialsLocked) fileInputRef.current?.click();
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!materialsLocked) setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    if (materialsLocked) return;
                    const files = Array.from(e.dataTransfer.files ?? []);
                    if (files.length > 0) handleFilesSelect(files);
                  }}
                >
                  <Paperclip className="size-5 text-muted-foreground/50 mb-1.5" />
                  <p className="text-xs font-medium">{t('toolbar.courseMaterialUpload')}</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5 text-center">
                    {t('upload.courseMaterialSizeLimit')}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60 text-center">
                    {t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES })}
                  </p>
                </div>

                {courseMaterials.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] text-muted-foreground/70">
                      {t('toolbar.courseMaterialMergeOrder')}
                    </p>
                    <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                      {[...courseMaterials]
                        .sort((a, b) => a.order - b.order)
                        .map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center gap-2 rounded-lg border border-border/50 px-2 py-2"
                          >
                            <div className="size-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
                              <FileText className="size-4 text-violet-600 dark:text-violet-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium truncate">
                                {file.order}. {file.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {(file.size / 1024 / 1024).toFixed(2)} MB
                              </p>
                            </div>
                            <button
                              onClick={() => onCourseMaterialRemove(file.id)}
                              disabled={materialsLocked}
                              className={cn(
                                'size-6 rounded-full inline-flex items-center justify-center text-muted-foreground transition-colors',
                                materialsLocked
                                  ? 'cursor-not-allowed opacity-40'
                                  : 'hover:bg-muted',
                              )}
                              aria-label={t('toolbar.removeCourseMaterial')}
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* ── Web Search ── */}
        {webSearchAvailable ? (
          <Popover>
            <PopoverTrigger asChild>
              <button className={webSearch ? pillActive : pillMuted}>
                <Globe2 className={cn('size-3.5', webSearch && 'animate-pulse')} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-3">
              {/* Toggle — the search engine itself is chosen in Settings, not here */}
              <button
                onClick={() => {
                  if (!selectedWebSearchAvailable) return;
                  onWebSearchChange(!webSearch);
                }}
                disabled={materialsLocked}
                className={cn(
                  'w-full flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all',
                  webSearch
                    ? 'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800'
                    : 'border-border hover:bg-muted/50',
                  !selectedWebSearchAvailable && 'opacity-60',
                  materialsLocked && 'opacity-60 cursor-not-allowed',
                )}
              >
                <Globe2
                  className={cn(
                    'size-4 shrink-0',
                    webSearch ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground',
                  )}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">
                    {webSearch ? t('toolbar.webSearchOn') : t('toolbar.webSearchOff')}
                  </p>
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    {t('toolbar.webSearchDesc')}
                  </p>
                </div>
              </button>
            </PopoverContent>
          </Popover>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(pillCls, 'text-muted-foreground/40 cursor-not-allowed')}
                disabled
              >
                <Globe2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('toolbar.webSearchNoProvider')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
