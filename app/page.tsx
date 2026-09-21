'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ImagePlus,
  Loader2,
  Pencil,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { fetchAuthMe } from '@/lib/auth/auth-me-client';
import { SiteHeader } from '@/components/site-header/site-header';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { coverGradient } from '@/lib/utils/cover-gradient';
import { SettingsDialog } from '@/components/settings';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { nanoid } from 'nanoid';
import { deleteDocumentBlob, storeDocumentBlob } from '@/lib/utils/image-storage';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import {
  courseMaterialFingerprint,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import type {
  SelectedCourseMaterial,
  SessionDocumentSource,
  UserRequirements,
} from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useAuthModalStore } from '@/lib/store/auth-modal';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import { resizeAvatarToDataUrl } from '@/lib/utils/avatar-upload';
import { useTeacherAvatarVoiceSync } from '@/lib/orchestration/registry/teacher-avatar';
import type { CourseCreationGrant } from '@/lib/server/course-creation-gate';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { isProWorkbenchEnabled, shouldShowVocationalTestUi } from '@/lib/config/feature-flags';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';
import { ProBadge } from '@/components/workbench/ProBadge';
import { arrivedByProSwap, startProSwap } from '@/lib/workbench/pro-swap';
import {
  readLastWorkspaceSessionId,
  workspaceResumeHref,
} from '@/lib/workbench/workspace-session-memory';

const log = createLogger('Home');

const WEB_SEARCH_STORAGE_KEY = 'webSearchEnabled';
const INTERACTIVE_MODE_STORAGE_KEY = 'interactiveModeEnabled';

/** The configured runtime probe result, retained across client navigations. */
let workbenchRuntimeCache: boolean | null = null;

interface FormState {
  courseMaterials: SelectedCourseMaterial[];
  requirement: string;
  webSearch: boolean;
  interactiveMode: boolean;
  vocationalTestMode: boolean;
}

const initialFormState: FormState = {
  courseMaterials: [],
  requirement: '',
  webSearch: false,
  interactiveMode: false,
  vocationalTestMode: false,
};

function HomePage() {
  const { t } = useI18n();
  const router = useRouter();
  // Keep the default teacher's portrait matched to the narration voice's
  // gender (female voice → female teacher avatar) while the roster is visible.
  useTeacherAvatarVoiceSync();
  // Do not replay the classic hero's entrance after the route handoff already
  // carried the lockup and composer into place.
  const [swapped] = useState(arrivedByProSwap);
  const heroEnter = (from: Record<string, number>) => (swapped ? false : from);
  const showVocationalTestUi = shouldShowVocationalTestUi();
  const workbenchBuildEnabled = isProWorkbenchEnabled();
  const [workbenchRuntimeEnabled, setWorkbenchRuntimeEnabled] = useState(
    workbenchRuntimeCache === true,
  );
  useEffect(() => {
    if (!workbenchBuildEnabled || workbenchRuntimeCache !== null) return;
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        workbenchRuntimeCache = body?.enabled === true;
        if (!cancelled) setWorkbenchRuntimeEnabled(workbenchRuntimeCache);
      })
      .catch(() => {
        // A failed probe keeps the entry hidden and allows a later visit to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [workbenchBuildEnabled]);
  const workbenchEntryEnabled = workbenchBuildEnabled && workbenchRuntimeEnabled;
  const enterWorkbench = () => {
    const href = workspaceResumeHref(readLastWorkspaceSessionId());
    startProSwap(href, (next) => router.push(next));
  };
  useEffect(() => {
    if (workbenchEntryEnabled) router.prefetch('/workspace');
  }, [router, workbenchEntryEnabled]);
  // Course-creation grant (admin-managed switch + quota): a known-denied grant
  // keeps the send button grayed and shows the amber notice beside the
  // web-search pill. `null` (signed out / probe failed) does NOT pre-gray —
  // the anonymous case is handled by the click-time login gate instead.
  const [creationGrant, setCreationGrant] = useState<CourseCreationGrant | null>(null);
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      // Shared with the layout's profile sync and the site header (same
      // response, one request per load; auth-changed invalidates).
      void fetchAuthMe<{ user?: { courseCreation?: CourseCreationGrant } }>()
        .then((snapshot) => {
          if (!cancelled) setCreationGrant(snapshot.body?.user?.courseCreation ?? null);
        })
        .catch(() => undefined);
    };
    probe();
    window.addEventListener('openmaic:auth-changed', probe);
    return () => {
      cancelled = true;
      window.removeEventListener('openmaic:auth-changed', probe);
    };
  }, []);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const hasUsableProvider = hasUsableLLMProvider(providersConfig);
  // Hydrate client-only state after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const savedWebSearch = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
      const savedInteractiveMode = localStorage.getItem(INTERACTIVE_MODE_STORAGE_KEY);
      const updates: Partial<FormState> = {};
      if (savedWebSearch === 'true') updates.webSearch = true;
      if (savedInteractiveMode === 'true') updates.interactiveMode = true;
      if (Object.keys(updates).length > 0) {
        setForm((prev) => ({ ...prev, ...updates }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement }));
  }, [cachedRequirement]);

  const [error, setError] = useState<string | null>(null);
  // True while the Generate click drains upload-time ingests and builds the
  // generation session. Doubles as the guard flag that freezes the course
  // material set for the duration of prep and as the switch that disables the
  // toolbar's add/remove affordances, so the session is always built from a
  // set that cannot change under it.
  const [preparingGenerate, setPreparingGenerate] = useState(false);
  // Recommended courses — the admin-published shelf (/api/explore), capped at
  // eight cards for the home grid. Admin-featured (推荐到首页) courses win the
  // slots; with none flagged the freshest published cards keep the grid alive
  // (the shelf already sorts featured-first). `null` while loading; `[]` on
  // error (the section shows its empty hint instead of a broken grid).
  const [recommended, setRecommended] = useState<RecommendedCourse[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/explore')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) return;
        const courses = (body as { courses?: RecommendedCourse[] } | null)?.courses ?? [];
        const featured = courses.filter((course) => course.featured);
        setRecommended(featured.length > 0 ? featured : courses);
      })
      .catch(() => {
        if (!cancelled) setRecommended([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The site banner's settings gear lives outside this component tree; it
  // signals through a window event instead of prop-drilling a dialog trigger.
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener('openmaic:open-settings', openSettings);
    return () => window.removeEventListener('openmaic:open-settings', openSettings);
  }, []);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'webSearch') localStorage.setItem(WEB_SEARCH_STORAGE_KEY, String(value));
      if (field === 'interactiveMode')
        localStorage.setItem(INTERACTIVE_MODE_STORAGE_KEY, String(value));
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const addCourseMaterials = (files: File[]) => {
    // The set is frozen for the duration of generate-prep: adding is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip into the set mid-prep.
    if (preparingGenerate) return;
    const dedupedFiles = dedupeCourseMaterialFiles(form.courseMaterials, files);
    const startOrder = form.courseMaterials.length + 1;
    const additions = dedupedFiles.map((file, index) => ({
      id: nanoid(8),
      file,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      order: startOrder + index,
    }));

    if (additions.length === 0) return;
    setForm((prev) => {
      // Pure updater: drop any addition the latest state already carries — by
      // id (a replayed or superseded update) or by content fingerprint (two
      // addCourseMaterials calls in one render batch both dedupe against the
      // same stale closure list, so the same file could otherwise enter twice
      // under two ids and ingest/extract twice) — then append the rest.
      const missing = additions.filter((addition) => {
        if (prev.courseMaterials.some((item) => item.id === addition.id)) return false;
        return !prev.courseMaterials.some(
          (item) => courseMaterialFingerprint(item) === courseMaterialFingerprint(addition),
        );
      });
      if (missing.length === 0) return prev;
      return { ...prev, courseMaterials: [...prev.courseMaterials, ...missing] };
    });
  };

  const removeCourseMaterial = (id: string) => {
    // The set is frozen for the duration of generate-prep: removing is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip out of the set mid-prep.
    if (preparingGenerate) return;
    setForm((prev) => ({
      ...prev,
      courseMaterials: prev.courseMaterials
        .filter((item) => item.id !== id)
        .map((item, index) => ({ ...item, order: index + 1 })),
    }));
  };

  const handleGenerate = async () => {
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (preparingGenerate) return;
    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    // Product gate: course generation requires a logged-in account. Checked
    // live on the click (never cached) so a logout elsewhere takes effect
    // immediately.
    try {
      const auth = await fetch('/api/auth/me');
      if (auth.status === 401) {
        toast.error(t('login.loginFirst'));
        useAuthModalStore.getState().openLogin('/');
        return;
      }
      // Grant backstop for a stale mount-time probe (e.g. the admin just
      // flipped the switch or the quota filled elsewhere).
      if (auth.ok) {
        const body = (await auth.json().catch(() => null)) as {
          user?: { courseCreation?: CourseCreationGrant };
        } | null;
        const grant = body?.user?.courseCreation ?? null;
        setCreationGrant(grant);
        if (grant && !grant.allowed) {
          toast.error(
            grant.reason === 'quota'
              ? t('toolbar.creationQuotaExceeded', { n: grant.limit })
              : t('toolbar.creationForbidden'),
          );
          return;
        }
      }
    } catch {
      // Network hiccup: fail open here — the generation pipeline surfaces its
      // own errors, and a flaky auth probe must not block a working session.
    }

    setError(null);

    // The material list and the extractor provider config are frozen for the
    // duration of prep: `preparingGenerate` makes add/remove inert and
    // disables the toolbar affordances (including the extractor Select and the
    // web-search toggle), so neither can change under the session build below.
    // Capture both at click time and build the session from this snapshot,
    // never from live form state or live store state.
    const frozenMaterials = [...form.courseMaterials].sort((a, b) => a.order - b.order);
    const settingsSnapshot = useSettingsStore.getState();
    const frozenPdfProviderId = settingsSnapshot.pdfProviderId;
    const frozenPdfProviderConfig = settingsSnapshot.pdfProvidersConfig?.[
      settingsSnapshot.pdfProviderId
    ]
      ? {
          apiKey: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].apiKey,
          baseUrl: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].baseUrl,
          accessKeyId:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeyId,
          accessKeySecret:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeySecret,
        }
      : undefined;

    // Flip the generating UI state before material bytes are copied locally.
    setPreparingGenerate(true);
    try {
      const userProfile = useUserProfileStore.getState();
      const requirements: UserRequirements = {
        requirement: form.requirement,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        webSearch: form.webSearch || undefined,
        interactiveMode: form.vocationalTestMode ? true : form.interactiveMode,
        ...(form.vocationalTestMode ? { taskEngineMode: true } : {}),
      };

      let documentSources: SessionDocumentSource[] | undefined;
      let pdfProviderId: string | undefined;
      let pdfProviderConfig:
        | { apiKey?: string; baseUrl?: string; accessKeyId?: string; accessKeySecret?: string }
        | undefined;

      if (frozenMaterials.length > 0) {
        // The session is built from the click-time snapshot (frozen above),
        // never from live store state.
        pdfProviderId = frozenPdfProviderId;
        pdfProviderConfig = frozenPdfProviderConfig;

        const storedDocumentKeys: string[] = [];
        try {
          documentSources = [];
          for (const [index, item] of frozenMaterials.entries()) {
            const storageKey = await storeDocumentBlob(item.file);
            storedDocumentKeys.push(storageKey);
            documentSources.push({
              id: item.id,
              name: item.name,
              size: item.size,
              lastModified: item.lastModified,
              mimeType: normalizeDocumentMimeType({
                mimeType: item.file.type,
                fileName: item.file.name,
              }),
              order: index + 1,
              storageKey,
              providerId: pdfProviderId,
            });
          }
        } catch (error) {
          await Promise.allSettled(storedDocumentKeys.map((key) => deleteDocumentBlob(key)));
          throw error;
        }
      }

      const sessionState = {
        sessionId: nanoid(),
        requirements,
        pdfText: '',
        pdfImages: [],
        imageStorageIds: [],
        documentSources,
        // Backward-compatible single-document fields for previously saved sessions.
        pdfStorageKey: documentSources?.[0]?.storageKey,
        pdfFileName: documentSources?.[0]?.name,
        documentMimeType: documentSources?.[0]?.mimeType,
        pdfProviderId,
        pdfProviderConfig,
        sceneOutlines: null,
        currentStep: 'generating' as const,
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    } finally {
      // Unfreeze the set once prep settles (navigation unmounts this page, so
      // this is normally a no-op on the way out).
      setPreparingGenerate(false);
    }
  };

  // A known-denied course-creation grant keeps the button grayed for good —
  // the amber toolbar notice carries the reason (permission or quota).
  const creationBlocked = creationGrant !== null && !creationGrant.allowed;
  const creationBlockHint =
    creationGrant && !creationGrant.allowed
      ? creationGrant.reason === 'quota'
        ? t('toolbar.creationQuotaExceeded', { n: creationGrant.limit })
        : t('toolbar.creationForbidden')
      : undefined;

  const canGenerate = !!form.requirement.trim() && hasUsableProvider && !creationBlocked;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate && !preparingGenerate) handleGenerate();
    }
  };

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center p-4 pt-24 md:p-8 md:pt-24 overflow-x-hidden">
      {/* ═══ Site banner: 80px header with logo, nav, and user center ═══ */}
      <SiteHeader />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      {/* ═══ Background Decor ═══ */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* ═══ Hero section: title + input (centered, wider) ═══ */}
      <motion.div
        initial={heroEnter({ opacity: 0, y: 20 })}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className={cn('relative z-20 w-full max-w-[800px] flex flex-col items-center mt-[10vh]')}
      >
        {/* ── Brand title ── */}
        <div className="relative" data-pro-morph="lockup">
          <motion.h1
            initial={heroEnter({ opacity: 0, scale: 0.9 })}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              delay: 0.1,
              type: 'spring',
              stiffness: 200,
              damping: 20,
            }}
            className="text-5xl md:text-6xl font-extrabold tracking-tight leading-tight text-violet-600 dark:text-violet-400"
          >
            AI Classroom
            {/* 非正式版本 — small marker at the title's top-right, riding the
                h1's line box so it flows before the absolutely-positioned
                ProBadge instead of colliding with it. */}
            <span className="ml-2 inline-block align-top rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium leading-none tracking-wide text-amber-600 dark:text-amber-400">
              {t('home.informalBuildBadge')}
            </span>
          </motion.h1>
          {workbenchEntryEnabled ? (
            <div
              className="absolute left-full top-0 ml-1.5 mt-[10px] md:ml-2 md:mt-[14px]"
              data-pro-morph="badge"
            >
              <ProBadge active={false} onToggle={enterWorkbench} />
            </div>
          ) : null}
        </div>

        {/* ── Slogan ── */}
        <motion.p
          initial={heroEnter({ opacity: 0 })}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          className="text-base md:text-lg text-muted-foreground/70 mt-3 mb-8"
        >
          {t('home.slogan')}
        </motion.p>

        {/* ── Unified input area ── */}
        <motion.div
          initial={heroEnter({ opacity: 0, scale: 0.97 })}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.35 }}
          className="w-full"
        >
          {/* ── Profile (left) + AI teacher & classmates (right), above the box ── */}
          <div className="relative z-20 flex w-full items-start justify-between">
            <GreetingBar />
            <div className="pr-1 pb-2 shrink-0">
              <AgentBar />
            </div>
          </div>

          <div
            data-pro-morph="composer"
            className="w-full rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 transition-shadow focus-within:shadow-2xl focus-within:shadow-violet-500/[0.06]"
          >
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              placeholder={t('upload.requirementPlaceholder')}
              className="w-full resize-none border-0 bg-transparent px-4 pt-3.5 pb-2 text-[13px] leading-relaxed placeholder:text-muted-foreground/40 focus:outline-none min-h-[160px] max-h-[300px]"
              value={form.requirement}
              onChange={(e) => updateForm('requirement', e.target.value)}
              onKeyDown={handleKeyDown}
              rows={5}
            />

            {/* Toolbar row */}
            <div className="px-3 pb-3 flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <GenerationToolbar
                  webSearch={form.webSearch}
                  onWebSearchChange={(v) => updateForm('webSearch', v)}
                  courseMaterials={form.courseMaterials}
                  onCourseMaterialsAdd={addCourseMaterials}
                  onCourseMaterialRemove={removeCourseMaterial}
                  onPdfError={setError}
                  materialsLocked={preparingGenerate}
                  creationBlockHint={creationBlockHint}
                />
              </div>

              {/* Interactive mode toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <InteractiveModeButton
                    pressed={form.interactiveMode}
                    label={t('toolbar.interactiveModeLabel')}
                    onPressedChange={(pressed) => updateForm('interactiveMode', pressed)}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('toolbar.interactiveModeHint')}
                </TooltipContent>
              </Tooltip>

              {/* Send button */}
              <button
                onClick={handleGenerate}
                disabled={!canGenerate || preparingGenerate}
                className={cn(
                  'shrink-0 h-8 rounded-lg flex items-center justify-center gap-1.5 transition-all px-3',
                  canGenerate && !preparingGenerate
                    ? 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm cursor-pointer'
                    : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
                )}
              >
                <span className="text-xs font-medium">
                  {preparingGenerate ? t('stage.generating') : t('toolbar.generateCourseware')}
                </span>
                {preparingGenerate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        </motion.div>

        {showVocationalTestUi && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-2 flex w-full justify-start px-1"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.vocationalTestMode}
                  onClick={() => updateForm('vocationalTestMode', !form.vocationalTestMode)}
                  className={cn(
                    'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                    form.vocationalTestMode
                      ? 'border-cyan-400/70 bg-cyan-50 text-cyan-700 shadow-[0_0_10px_rgba(6,182,212,0.16)] dark:bg-cyan-950/40 dark:text-cyan-300'
                      : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/60 hover:text-cyan-700 dark:hover:text-cyan-300',
                  )}
                >
                  <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-cyan-700 dark:bg-cyan-900/45 dark:text-cyan-300">
                    测试功能
                  </span>
                  <Sparkles className="size-3.5" />
                  <span>职教任务</span>
                  <span
                    className={cn(
                      'relative h-3.5 w-6 rounded-full transition-colors',
                      form.vocationalTestMode ? 'bg-cyan-500' : 'bg-muted-foreground/25',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 size-2.5 rounded-full bg-white transition-transform',
                        form.vocationalTestMode ? 'translate-x-2.5' : 'translate-x-0',
                      )}
                    />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                从当前输入框提交职教实操训练测试
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}

        {/* ── Error ── */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 w-full p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
            >
              <p className="text-sm text-destructive">{error}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ═══ Recommended courses — admin-published shelf ═══ */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="relative z-10 mt-12 w-full max-w-6xl flex flex-col"
      >
        {/* Banner */}
        <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 px-5 py-3.5">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight text-foreground">
              {t('home.recommendedTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              {t('home.recommendedSubtitle')}
            </p>
          </div>
        </div>

        {/* Grid — at most 8 courses, four per row */}
        <div className="mt-6 grid w-full grid-cols-2 gap-5 md:grid-cols-4">
          {recommended === null ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border/40 p-3">
                <div className="aspect-[16/9] animate-pulse rounded-xl bg-muted/50" />
                <div className="mt-3 h-4 w-1/2 animate-pulse rounded-full bg-muted/50" />
                <div className="mt-2 h-3 w-3/4 animate-pulse rounded-full bg-muted/40" />
              </div>
            ))
          ) : recommended.length === 0 ? (
            <p className="col-span-full py-10 text-center text-sm text-muted-foreground/60">
              {t('home.recommendedEmpty')}
            </p>
          ) : (
            recommended.slice(0, 8).map((course, i) => (
              <motion.div
                key={course.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.35, ease: 'easeOut' }}
              >
                <RecommendedCourseCard
                  course={course}
                  onOpen={() => router.push(`/classroom/${course.id}`)}
                />
              </motion.div>
            ))
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const accountName = useUserProfileStore((s) => s.accountName);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(true);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Same resolution as the site header: AI 昵称, else the logged-in account's
  // 真实姓名/工号 (synced by account-profile-sync), else the generic 同学 —
  // so the greeting always reads as the current user.
  const nameFallback = accountName || t('profile.defaultNickname');
  const displayName = nickname || nameFallback;

  // The dialog owns outside-click dismissal; the avatar picker deliberately
  // starts EXPANDED on every open (头像选择默认展开), so only the in-place
  // name editor needs resetting on close.
  const handleDialogOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setAvatarPickerOpen(true);
    else setEditingName(false);
  };

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    resizeAvatarToDataUrl(file).then(
      (dataUrl) => setAvatar(dataUrl),
      (reason) => {
        toast.error(
          reason === 'too-large' ? t('profile.fileTooLarge') : t('profile.invalidFileType'),
        );
      },
    );
  };

  return (
    <div className="pl-1 pr-2 pb-2">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        {/* ── Trigger pill (always in flow, top-left of the composer) ── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group h-10 rounded-2xl px-3 border border-border/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 text-muted-foreground/70 hover:text-foreground active:scale-[0.98]"
              >
                <div className="shrink-0 relative">
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-violet-400/60 dark:group-hover:ring-violet-400/40 transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <div className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/40 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
                    <Pencil className="size-[7px] text-muted-foreground/70" />
                  </div>
                </div>
                <span className="text-[13px] text-muted-foreground group-hover:text-foreground transition-colors select-none">
                  {t('home.knowYou')}
                </span>
                <ChevronDown className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
              </button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t('profile.editTooltip')}
          </TooltipContent>
        </Tooltip>

        {/* ── Profile dialog ── */}
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('profile.knowYouTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {/* ── Row: avatar + name ── */}
            <div className="flex items-center gap-2.5">
              {/* Avatar */}
              <div
                className="shrink-0 relative cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setAvatarPickerOpen(!avatarPickerOpen);
                }}
              >
                <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-violet-300/70 dark:ring-violet-500/40 transition-all duration-300">
                  <img src={avatar} alt="" className="size-full object-cover" />
                </div>
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/60 flex items-center justify-center"
                >
                  <ChevronDown
                    className={cn(
                      'size-2 text-muted-foreground/70 transition-transform duration-200',
                      avatarPickerOpen && 'rotate-180',
                    )}
                  />
                </motion.div>
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                {editingName ? (
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      ref={nameInputRef}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitName();
                        if (e.key === 'Escape') {
                          setEditingName(false);
                        }
                      }}
                      onBlur={commitName}
                      maxLength={20}
                      placeholder={nameFallback}
                      className="flex-1 min-w-0 h-6 bg-transparent border-b border-border/80 text-[13px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
                    />
                    <button
                      onClick={commitName}
                      className="shrink-0 size-5 rounded flex items-center justify-center text-violet-500 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                    >
                      <Check className="size-3" />
                    </button>
                  </div>
                ) : (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditName();
                    }}
                    className="group/name inline-flex items-center gap-1 cursor-pointer"
                  >
                    <span className="text-[13px] font-semibold text-foreground/85 group-hover/name:text-foreground transition-colors">
                      {displayName}
                    </span>
                    <Pencil className="size-2.5 text-muted-foreground/30 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                  </span>
                )}
              </div>
            </div>

            {/* Avatar picker */}
            <AnimatePresence>
              {avatarPickerOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                    {AVATAR_OPTIONS.map((url) => (
                      <button
                        key={url}
                        onClick={() => setAvatar(url)}
                        className={cn(
                          'size-7 rounded-full overflow-hidden bg-gray-50 dark:bg-gray-800 cursor-pointer transition-all duration-150',
                          'hover:scale-110 active:scale-95',
                          avatar === url
                            ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0'
                            : 'hover:ring-1 hover:ring-muted-foreground/30',
                        )}
                      >
                        <img src={url} alt="" className="size-full" />
                      </button>
                    ))}
                    <label
                      className={cn(
                        'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                        'hover:scale-110 active:scale-95',
                        isCustomAvatar(avatar)
                          ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0 border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30'
                          : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50',
                      )}
                      onClick={() => avatarInputRef.current?.click()}
                      title={t('profile.uploadAvatar')}
                    >
                      <ImagePlus className="size-3" />
                    </label>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bio — gray hint above the textarea */}
            <div>
              <p className="text-xs text-muted-foreground/60 mb-1.5 select-none">
                {t('profile.bioHint')}
              </p>
              <UITextarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={t('profile.bioPlaceholder')}
                maxLength={200}
                rows={4}
                className="resize-none border-border/40 bg-transparent min-h-[96px] !text-[13px] !leading-relaxed placeholder:!text-[11px] placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm">{t('profile.done')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Recommended courses — card ──────────────────────────────
export interface RecommendedCourse {
  id: string;
  name: string;
  sceneCount: number;
  updatedAt: string;
  categoryName: string | null;
  /** 推荐到首页 — admin-curated for this grid (see /api/explore). */
  featured?: boolean;
  /** Per-course generated cover, when one exists; falls back to a default. */
  coverUrl?: string;
}

function RecommendedCourseCard({
  course,
  onOpen,
}: {
  course: RecommendedCourse;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const generatedAt = new Date(course.updatedAt).toLocaleDateString();

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full cursor-pointer rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-2xl"
    >
      {/* Cover — per-course art when present, otherwise a default gradient */}
      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl">
        {course.coverUrl ? (
          <img
            src={course.coverUrl}
            alt={course.name}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <div
            className={cn(
              'flex size-full items-center justify-center bg-gradient-to-br transition-transform duration-300 group-hover:scale-[1.04]',
              coverGradient(course.id),
            )}
          >
            <div className="absolute size-16 rounded-full bg-white/10" />
            <BookOpen className="relative size-7 text-white/90" />
          </div>
        )}
      </div>

      {/* Category + tags */}
      <div className="mt-2.5 flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 rounded-full bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
          {course.categoryName || t('home.recommendedCategoryFallback')}
        </span>
        <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          {t('home.recommendedTagAi')}
        </span>
      </div>

      {/* Generated at · author · pages */}
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <span className="shrink-0 tabular-nums">{generatedAt}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate">{t('home.recommendedAuthor')}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0 tabular-nums">
          {course.sceneCount} {t('classroom.slides')}
        </span>
      </div>

      {/* Course name */}
      <p className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug text-foreground/90">
        {course.name}
      </p>
    </button>
  );
}

export default function Page() {
  return <HomePage />;
}
