'use client';

/**
 * The dock's global edit bar — one row, above the timeline, that never changes.
 *
 * What lands here is what acts on the COURSE rather than on the page's narration:
 * which page you are on, who is in the class, and which elements you are handing
 * the agent. None of it belongs inside the timeline (a spoken line has nothing to
 * say about the cast), and none of it belongs floating over the canvas — a pill
 * hovering on the slide covers the very content it is about to replace.
 *
 * Information structure: paging in the CENTRE, because it is the one control the
 * user reaches for constantly and centre is where the eye returns; the lasso
 * rides the right flank so it cannot be mistaken for part of the timeline
 * below it. (The roster entry that used to hold the left flank is hidden by
 * the course-page redesign for now.)
 *
 * Deliberately not a new visual idiom: the same flat icon buttons, the same type
 * scale and the same hairline the timeline header already uses. It stays visible
 * (and usable) while the dock is folded, because none of it is about the fold.
 */
import { useI18n } from '@/lib/hooks/use-i18n';
import { CanvasPager, type CanvasPagerProps } from '@/components/edit/EditShell/CanvasPager';
import { ElementRefLassoButton } from './ElementRefLassoButton';

/** The bar's own height, in px. The dock adds it to whatever the timeline is. */
export const DOCK_EDIT_BAR_HEIGHT = 36;

export function DockEditBar({
  sceneId,
  /** Canvas elements to point at — only a slide has any. */
  canPickElements,
  pager,
}: {
  readonly sceneId: string;
  readonly canPickElements: boolean;
  readonly pager?: CanvasPagerProps;
}) {
  const { t } = useI18n();

  return (
    <>
      <div
        role="group"
        data-testid="edit-dock-bar"
        aria-label={t('edit.dock.globalTools')}
        // Three tracks rather than a flex row with spacers: the pager must be
        // centred on the DOCK, not on whatever is left over after the flanks.
        className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-gray-100 px-6 dark:border-gray-800"
      >
        <div className="flex min-w-0 items-center gap-1">
          {/* The 阵容 (roster) entry lived here; hidden by the course-page
              redesign for now — the left track stays so the pager keeps its
              centre anchor and the lasso keeps its right flank. */}
        </div>

        <div className="flex items-center justify-center">
          {pager && pager.count > 0 ? <CanvasPager {...pager} variant="dock" /> : null}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
          {canPickElements ? <ElementRefLassoButton sceneId={sceneId} /> : null}
        </div>
      </div>
    </>
  );
}
