/**
 * Courseware AI production log (课件AI制作日志).
 *
 * One chronological record per course of what the generation pipeline did to
 * each page — phase transitions, completions, and the reason a page failed —
 * so the author can open a timeline of "what was the AI doing / why is this
 * page stuck" instead of inferring it from the current status alone.
 *
 * Entries are written by the scene generator at the moment something happens
 * (messages pre-localized through the client i18n), persisted per stage in the
 * KV `account` scope, and read by the stage header's log dialog newest-first.
 * Failed-page state survives reload (the stage store seeds interrupted
 * outlines back into `failedOutlines`), so the log persists too — the button
 * stays visible for a failed course and the reasons remain readable.
 */
'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createKVPersistStorage } from '@/lib/store/kv-persist';

export type GenerationLogLevel = 'info' | 'success' | 'warning' | 'error';

/** Machine-readable phase tag (which pipeline step the entry describes). */
export type GenerationLogPhase =
  | 'start'
  | 'content'
  | 'actions'
  | 'scene-done'
  | 'retry'
  | 'completed'
  | 'paused'
  | 'media';

export interface GenerationLogEntry {
  id: string;
  /** Client clock at capture time. */
  at: number;
  level: GenerationLogLevel;
  phase: GenerationLogPhase;
  /** 1-based page order, when the entry is about one page. */
  sceneOrder?: number;
  /** Outline title at generation time, when the entry is about one page. */
  sceneTitle?: string;
  /** Pre-localized human description (interpolated at capture time). */
  message: string;
}

/** Per-course cap — a log is a timeline, not an archive. */
const MAX_ENTRIES_PER_STAGE = 300;
/** How many courses keep logs at all; the stalest is evicted beyond this. */
const MAX_STAGES = 20;

interface GenerationLogState {
  /** stageId → entries, oldest → newest. */
  logsByStage: Record<string, GenerationLogEntry[]>;
  appendGenerationLog: (
    stageId: string,
    entry: Omit<GenerationLogEntry, 'id' | 'at'> & { at?: number },
  ) => void;
  /** Drop one course's log entirely (the dialog's 清空 action). */
  clearStageGenerationLog: (stageId: string) => void;
}

/** Monotonic within this tab; pairs with `Date.now()` to keep ids unique. */
let entrySeq = 0;

export const useGenerationLogStore = create<GenerationLogState>()(
  persist(
    (set) => ({
      logsByStage: {},
      appendGenerationLog: (stageId, entry) =>
        set((state) => {
          const existing = state.logsByStage[stageId] ?? [];
          const logged: GenerationLogEntry = {
            ...entry,
            at: entry.at ?? Date.now(),
            id: `${Date.now().toString(36)}-${(entrySeq++).toString(36)}`,
          };
          // Evict the least-recently-written OTHER course before a new course
          // claims a slot, so one busy account cannot grow the blob unbounded.
          let logsByStage = state.logsByStage;
          if (!existing.length && Object.keys(logsByStage).length >= MAX_STAGES) {
            const stageIds = Object.keys(logsByStage);
            const lastAt = (id: string): number => {
              const entries = logsByStage[id];
              return entries.length ? entries[entries.length - 1].at : 0;
            };
            const stalest = stageIds.reduce((a, b) => (lastAt(a) <= lastAt(b) ? a : b));
            const pruned = { ...logsByStage };
            delete pruned[stalest];
            logsByStage = pruned;
          }
          return {
            logsByStage: {
              ...logsByStage,
              [stageId]: [...existing, logged].slice(-MAX_ENTRIES_PER_STAGE),
            },
          };
        }),
      clearStageGenerationLog: (stageId) =>
        set((state) => {
          if (!state.logsByStage[stageId]) return state;
          const logsByStage = { ...state.logsByStage };
          delete logsByStage[stageId];
          return { logsByStage };
        }),
    }),
    {
      name: 'generation-log-storage',
      // Course-scoped author data: a server-backed deployment may sync it.
      storage: createKVPersistStorage<Partial<GenerationLogState>>('account'),
      version: 1,
      partialize: (state) => ({ logsByStage: state.logsByStage }),
    },
  ),
);
