'use client';

import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter } from 'next/navigation';
import type { StageMode } from '@/lib/types/stage';
import { HeaderControls } from './stage/header-controls';
import { CourseInfoPopover } from './stage/course-info-popover';
import { useSettingsStore } from '@/lib/store/settings';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

interface HeaderProps {
  /** Course name — rendered in the small gray eyebrow above the title,
      followed by the page indicator. */
  readonly courseTitle: string;
  /** 1-based number of the current scene (or the pending/course-complete
      slot, numbered like the sidebar placeholder). */
  readonly currentPage: number;
  readonly totalPages: number;
  /** Title of the selected scene (PPT page) — the big title under the
      eyebrow. */
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /** Replaces the centered control bar's navigation cluster while a
      workbench session is attached and full-screen playback is on: the host
      provides its own return control (left slot), so the standalone
      首页/返回 pair must not appear beside it. */
  readonly backControl?: ReactNode;
  /** Drops the navigation cluster entirely (no `backControl`, no 首页/返回).
      The embedded workbench form uses this: the conversation sits beside the
      classroom, so any back affordance here would duplicate the chat's own
      and could exit the workbench. */
  readonly hideBackControl?: boolean;
  /** Hide application-global controls in a workbench-attached classroom. */
  readonly hideGlobalControls?: boolean;
  /** Hide course-level share/export in a workbench-attached classroom. */
  readonly hideCourseActions?: boolean;
}

/** Shared shape of the control bar's icon buttons. */
const barBtn =
  'p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 ' +
  'hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all';

export function Header({
  courseTitle,
  currentPage,
  totalPages,
  currentSceneTitle,
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  backControl,
  hideBackControl,
  hideGlobalControls,
  hideCourseActions,
}: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();

  // Panel collapse state lives in the persisted settings store — the control
  // bar reads/writes it directly, so the toggles work no matter which chrome
  // layer originally owned the panels.
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
  const chatAreaCollapsed = useSettingsStore((s) => s.chatAreaCollapsed);
  const setChatAreaCollapsed = useSettingsStore((s) => s.setChatAreaCollapsed);

  // Leaving the classroom is a two-step intent: the icon only arms a
  // confirmation; the action runs after 确认.
  const [pendingLeave, setPendingLeave] = useState<null | 'home' | 'back'>(null);

  const confirmLeave = () => {
    const action = pendingLeave;
    setPendingLeave(null);
    if (action === 'home') {
      router.push('/');
    } else if (action === 'back') {
      // 返回上一页 — actual history back; a direct open (no history) falls
      // back to home so the button never dead-ends.
      if (typeof window !== 'undefined' && window.history.length > 1) router.back();
      else router.push('/');
    }
  };

  // The standalone classroom owns its navigation; a hosted one either gets
  // the workbench's return control (left slot) or none at all.
  const standaloneNav = !hideBackControl && !backControl;

  return (
    <>
      <header className="relative h-20 px-8 flex items-center justify-between z-10 bg-transparent gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {hideBackControl ? null : backControl}
          {/* 首页 / 返回上一页 — back beside the scene title, like the
              pre-redesign layout. Standalone classroom only: a hosted one
              either gets the workbench's own return control above or none. */}
          {mode !== 'edit' && standaloneNav && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setPendingLeave('home')}
                className={barBtn}
                aria-label={t('generation.backToHome')}
                title={t('generation.backToHome')}
              >
                <Home className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPendingLeave('back')}
                className={barBtn}
                aria-label={t('stage.backToPrevPage')}
                title={t('stage.backToPrevPage')}
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            </div>
          )}
          {/* Title block — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <div className="flex flex-col min-w-0">
              {/* Small gray eyebrow — the slot that used to say 当前场景 now
                  carries the course name + page indicator. */}
              <span className="text-[10px] uppercase tracking-widest font-bold text-gray-400 dark:text-gray-500 mb-0.5 truncate select-none">
                {courseTitle ? `${courseTitle} · ` : ''}
                <span className="tabular-nums">
                  {currentPage}/{totalPages}
                </span>
              </span>
              {/* Big title — the selected PPT page's title, as before. */}
              <h1
                className="text-xl font-bold text-gray-800 dark:text-gray-200 tracking-tight truncate"
                suppressHydrationWarning
              >
                {currentSceneTitle || t('common.loading')}
              </h1>
            </div>
          )}
        </div>

        {/* ── Right cluster — panel-toggle bar + course info, sitting right
            beside the 修改课件模式 switch. The expand/collapse affordances
            that used to live in the canvas toolbar (and the sidebar's own
            header) are collected here, per the product redesign. */}
        <div className="flex items-center gap-2 shrink-0">
          {mode !== 'edit' && (
            <div
              className={cn(
                'flex items-center gap-1 rounded-full px-1.5 py-1',
                'bg-white/60 dark:bg-gray-800/60 border border-gray-100/50 dark:border-gray-700/50',
                'backdrop-blur-md shadow-sm',
              )}
            >
              {/* Left panel (page list) toggle */}
              <button
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className={cn(
                  barBtn,
                  sidebarCollapsed
                    ? 'text-gray-400 dark:text-gray-500'
                    : 'text-gray-600 dark:text-gray-300',
                )}
                aria-label={t('stage.togglePageList')}
                title={t('stage.togglePageList')}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="w-4 h-4" />
                ) : (
                  <PanelLeftClose className="w-4 h-4" />
                )}
              </button>

              <div className="w-px h-4 bg-gray-200/80 dark:bg-gray-700/60 mx-0.5 shrink-0" />

              {/* Right panel (chat) toggle */}
              <button
                onClick={() => setChatAreaCollapsed(!chatAreaCollapsed)}
                className={cn(
                  barBtn,
                  chatAreaCollapsed
                    ? 'text-gray-400 dark:text-gray-500'
                    : 'text-gray-600 dark:text-gray-300',
                )}
                aria-label={t('stage.toggleChatPanel')}
                title={t('stage.toggleChatPanel')}
              >
                {chatAreaCollapsed ? (
                  <PanelRightOpen className="w-4 h-4" />
                ) : (
                  <PanelRightClose className="w-4 h-4" />
                )}
              </button>

              {/* 课件信息 */}
              <CourseInfoPopover iconButtonClass={barBtn} />
            </div>
          )}

          {/* Standalone classroom keeps the full cluster. Workbench-attached
              classrooms omit both the global capsule and course
              share/export. */}
          <HeaderControls
            mode={mode}
            proModeActive={proModeActive}
            canEdit={canEdit}
            onToggleEditMode={onToggleEditMode}
            showGlobalControls={!hideGlobalControls}
            showCourseActions={!hideCourseActions}
          />
        </div>
      </header>

      {/* Leave confirmations — one dialog, two prompts. */}
      <AlertDialog open={pendingLeave !== null} onOpenChange={(o) => !o && setPendingLeave(null)}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogTitle className="text-left">
            {pendingLeave === 'home' ? t('stage.confirmLeaveHome') : t('stage.confirmLeaveBack')}
          </AlertDialogTitle>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLeave}>{t('common.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
