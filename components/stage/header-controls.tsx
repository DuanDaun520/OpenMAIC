'use client';

import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CourseInfoPopover } from '@/components/stage/course-info-popover';
import { GenerationLogButton } from '@/components/stage/generation-log-dialog';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  readonly showGlobalControls?: boolean;
  readonly showCourseActions?: boolean;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/** The edit chrome's trigger styling for the 课件信息 popover — the
 * CommandBar's flat zinc icon-button idiom. */
const editInfoBtn =
  'p-2 rounded-full text-gray-400 dark:text-gray-500 ' +
  'hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 ' +
  'transition-all';

/**
 * Stage-level global controls. Both the playback (non-edit) course page and
 * the edit chrome show the same lean cluster: the 课件信息 popover plus the
 * owner-gated 修改课件模式 switch. The redesign moved language / theme /
 * settings out of the classroom view and hid the download menu for now
 * (history keeps the old full cluster).
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so popover state stays co-located here without
 * cross-instance leakage.
 */
export function HeaderControls({
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  showGlobalControls = true,
  showCourseActions = true,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();

  const compact = variant === 'compact';
  const proChecked = proModeActive ?? mode === 'edit';

  // Playback (non-edit) chrome — and any workbench-attached classroom: the
  // course-page redesign reduced this cluster to the owner-gated
  // 修改课件模式 switch alone (the playback Header's control bar already
  // carries the 课件信息 popover beside it). Stage already omits
  // `onToggleEditMode` for non-owners, so visitors see nothing here.
  if (mode !== 'edit' || (!showGlobalControls && !showCourseActions)) {
    if (!onToggleEditMode) return null;
    return (
      <div className="flex items-center gap-2">
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 rounded-full border shadow-sm transition-colors duration-200',
            'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md',
            compact ? 'h-8 px-2.5' : 'h-9 px-3',
            proChecked
              ? 'border-violet-500/60 dark:border-violet-400/60'
              : 'border-gray-100/50 dark:border-gray-700/50',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          title={
            !canEdit && mode !== 'edit'
              ? t('stage.proModeDisabledHint')
              : proChecked
                ? t('stage.doneEditing')
                : t('stage.editCourse')
          }
        >
          <span
            className={cn(
              'text-xs font-bold select-none transition-colors duration-200',
              proChecked
                ? 'text-violet-600 dark:text-violet-300'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {compact ? t('edit.proMode') : t('edit.coursewareMode')}
          </span>
          <Switch
            checked={proChecked}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>

        {/* 课件AI制作日志 — visible only while generating / with failed pages */}
        <GenerationLogButton compact={compact} />
      </div>
    );
  }

  // Edit (修改课件模式) chrome — same lean cluster as the learning view:
  // 课件信息 popover + the switch that exits back to playback. Language /
  // theme / settings and the export menu are retired from the classroom
  // chrome for now. Self-contained spacing so the cluster is identical
  // regardless of host.
  return (
    <div className="flex items-center gap-2">
      <CourseInfoPopover iconButtonClass={editInfoBtn} />

      {onToggleEditMode && (
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 rounded-full border shadow-sm transition-colors duration-200',
            'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md',
            compact ? 'h-8 px-2.5' : 'h-9 px-3',
            proChecked
              ? 'border-violet-500/60 dark:border-violet-400/60'
              : 'border-gray-100/50 dark:border-gray-700/50',
            'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          title={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
        >
          <span
            className={cn(
              'text-xs font-bold select-none transition-colors duration-200',
              proChecked
                ? 'text-violet-600 dark:text-violet-300'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {compact ? t('edit.proMode') : t('edit.coursewareMode')}
          </span>
          <Switch
            checked={proChecked}
            onCheckedChange={onToggleEditMode}
            aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>
      )}

      {/* 课件AI制作日志 — visible only while generating / with failed pages */}
      <GenerationLogButton compact={compact} />
    </div>
  );
}
