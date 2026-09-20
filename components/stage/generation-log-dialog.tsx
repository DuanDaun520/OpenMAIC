'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ScrollText, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import {
  useGenerationLogStore,
  type GenerationLogEntry,
  type GenerationLogLevel,
} from '@/lib/store/generation-log';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const LEVEL_STYLES: Record<GenerationLogLevel, string> = {
  info: 'text-sky-500',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
};

function LevelIcon({ level }: { level: GenerationLogLevel }) {
  if (level === 'success') return <CheckCircle2 className="w-4 h-4 shrink-0" />;
  if (level === 'warning') return <AlertTriangle className="w-4 h-4 shrink-0" />;
  if (level === 'error') return <XCircle className="w-4 h-4 shrink-0" />;
  return <span className="w-2 h-2 rounded-full bg-current inline-block shrink-0" />;
}

function formatLogTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 课件AI制作日志 — a log button beside the 修改课件模式 switch that opens a
 * dialog listing the course's per-page generation events, newest first.
 *
 * Visibility follows the run: shown while generating and whenever pages have
 * failed (failed state survives reload — the stage store re-seeds interrupted
 * outlines — and so does the log); hidden once everything succeeded.
 */
export function GenerationLogButton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const stage = useStageStore((s) => s.stage);
  const generationStatus = useStageStore((s) => s.generationStatus);
  const failedCount = useStageStore((s) => s.failedOutlines.length);
  const entries = useGenerationLogStore((s) => (stage ? s.logsByStage[stage.id] : undefined));
  const clearStageGenerationLog = useGenerationLogStore((s) => s.clearStageGenerationLog);
  const [open, setOpen] = useState(false);

  const generating = generationStatus === 'generating';
  if (!stage || !(generating || failedCount > 0)) return null;

  const size = compact ? 'w-8 h-8' : 'w-9 h-9';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative shrink-0 inline-flex items-center justify-center rounded-full border shadow-sm',
            'bg-white/60 dark:bg-gray-800/60 backdrop-blur-md transition-colors duration-200',
            'border-gray-100/50 dark:border-gray-700/50 cursor-pointer',
            'hover:border-violet-400/60 dark:hover:border-violet-500/50',
            generating
              ? 'text-violet-600 dark:text-violet-300'
              : 'text-gray-500 dark:text-gray-400',
            size,
          )}
          aria-label={t('generationLog.title')}
          title={
            generating
              ? t('generationLog.generating')
              : t('generationLog.failedCount', { count: failedCount })
          }
        >
          {generating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ScrollText className="w-4 h-4" />
          )}
          {!generating && failedCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-4 text-center tabular-nums">
              {failedCount > 9 ? '9+' : failedCount}
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="w-4 h-4" />
            {t('generationLog.title')}
          </DialogTitle>
        </DialogHeader>
        {entries && entries.length > 0 ? (
          <>
            <div className="flex justify-end">
              <button
                type="button"
                className="text-xs text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                onClick={() => clearStageGenerationLog(stage.id)}
              >
                {t('generationLog.clear')}
              </button>
            </div>
            <ScrollArea className="h-80 -mx-2 px-2">
              <ol className="space-y-3" role="log">
                {[...entries].reverse().map((entry: GenerationLogEntry) => (
                  <li key={entry.id} className="flex items-start gap-2.5">
                    <span className={cn('mt-0.5', LEVEL_STYLES[entry.level])}>
                      <LevelIcon level={entry.level} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'text-sm leading-snug break-words',
                          entry.level === 'error'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-gray-700 dark:text-gray-300',
                        )}
                      >
                        {entry.message}
                      </p>
                      <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                        {formatLogTime(entry.at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            {t('generationLog.empty')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
