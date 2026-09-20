'use client';

import { useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { SceneType } from '@/lib/types/stage';
import { isSlideContent } from '@/lib/types/stage';
import { useStageStore } from '@/lib/store';
import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * 课件信息 popover — course cover / name / intro / author / created time.
 * Shared by the playback header's control bar and the edit chrome's
 * HeaderControls, so both modes show the same course facts.
 */
export function CourseInfoPopover({
  iconButtonClass,
}: {
  /** The host control bar's shared icon-button classes, reused for the trigger. */
  readonly iconButtonClass: string;
}) {
  const { t } = useI18n();
  const stage = useStageStore((s) => s.stage);
  const scenes = useStageStore((s) => s.scenes);
  const isOwner = useStageStore((s) => s.isOwner);
  const [open, setOpen] = useState(false);
  // Explicit AI cover from the stage-meta sidecar; fetched once per course
  // when the popover first opens (the document itself does not carry it).
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const fetchedStageRef = useRef<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next || !stage?.id || fetchedStageRef.current === stage.id) return;
    fetchedStageRef.current = stage.id;
    void fetchStageMeta(stage.id).then((result) => {
      // 404/unavailable just means no explicit cover — the first-page
      // thumbnail below is the default anyway.
      if (result.outcome === 'found' && result.meta.coverUrl) setCoverUrl(result.meta.coverUrl);
    });
  };

  // Cover fallback: the first slide's canvas, rendered small.
  const firstSlideContent = (() => {
    const scene = scenes.find((s) => s.type === 'slide');
    if (!scene || typeof scene.content !== 'object' || !('type' in scene.content)) return null;
    const tagged = scene.content as { type: SceneType };
    return isSlideContent(tagged) ? tagged.canvas : null;
  })();

  const createdAt = stage?.createdAt
    ? new Date(stage.createdAt).toLocaleString('zh-CN', { hour12: false })
    : '';

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            iconButtonClass,
            'flex items-center gap-1.5 px-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap',
          )}
          aria-label={t('stage.courseInfo')}
        >
          <BookOpen className="w-4 h-4 shrink-0" />
          <span>{t('stage.courseInfo')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={10}
        className="w-80 rounded-2xl p-0 overflow-hidden border border-gray-100/60 dark:border-gray-800/60 shadow-xl"
      >
        {/* Cover — AI cover > first-page thumbnail > placeholder */}
        <div className="aspect-video w-full bg-gray-100 dark:bg-gray-800">
          {coverUrl ? (
            <img src={coverUrl} alt={stage?.name || ''} className="size-full object-cover" />
          ) : firstSlideContent ? (
            <SlideThumbnail slide={firstSlideContent} viewportRatio={0.5625} />
          ) : (
            <div className="flex size-full items-center justify-center text-gray-300 dark:text-gray-600">
              <BookOpen className="w-8 h-8" />
            </div>
          )}
        </div>

        <div className="p-4 space-y-3">
          <h3 className="font-bold text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">
            {stage?.name || t('common.loading')}
          </h3>

          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {t('stage.courseInfoDesc')}
              </dt>
              <dd className="mt-0.5 text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-4">
                {stage?.description || t('stage.courseInfoNoDesc')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-400 dark:text-gray-500 shrink-0">
                {t('stage.courseInfoAuthor')}
              </span>
              <span className="text-gray-700 dark:text-gray-300 truncate">
                {isOwner ? t('stage.courseInfoAuthorSelf') : t('stage.courseInfoAuthorAnonymous')}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-400 dark:text-gray-500 shrink-0">
                {t('stage.courseInfoCreatedAt')}
              </span>
              <span className="text-gray-700 dark:text-gray-300 tabular-nums">{createdAt}</span>
            </div>
          </dl>
        </div>
      </PopoverContent>
    </Popover>
  );
}
