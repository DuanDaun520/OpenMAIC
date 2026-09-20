export interface AgentSelection {
  mode: 'preset' | 'auto';
  selectedAgentIds: string[];
}

export interface RestoredAgentSelection {
  selection: AgentSelection;
  /** Whether `selection` is the user's explicit choice (vs stage-derived defaults). */
  isUserSet: boolean;
}

/**
 * Decide the agent mode/selection to apply when a classroom loads.
 *
 * A stage that carries its own roster (`generatedAgentConfigs`, hydrated into
 * `generatedAgentIds`) plays THAT roster — always, for every viewer. The
 * roster's portraits and voice bindings are recorded on the document at
 * generation time; letting a viewer's global preset choice override them
 * would retroactively restyle the course whenever they change their homepage
 * 预设AI老师与同学 (voice and portrait are properties of the course, not of
 * whoever opens it — including the other learners of a published course).
 * The only user choice honored on a roster-carrying stage is an auto
 * selection drawn from this stage's own agents (a within-course pick).
 *
 * Stages WITHOUT a roster (legacy preset stages that recorded bare preset
 * ids) still honor an explicit user preset choice carried across classrooms,
 * and stage-derived defaults written by previous loads are never re-read as
 * user choices — visiting a preset classroom must not permanently downgrade
 * every roster classroom's stored selection.
 *
 * The fallback reproduces the previous unconditional behavior: auto with all
 * generated agents when the stage has them, else the stage's preset agents,
 * else the full default lineup.
 */
export function restoreAgentSelection(params: {
  persisted: AgentSelection;
  persistedIsUserSet: boolean;
  generatedAgentIds: string[];
  stageAgentIds?: string[];
  isPresetAgent: (id: string) => boolean;
}): RestoredAgentSelection {
  const { persisted, persistedIsUserSet, generatedAgentIds, stageAgentIds, isPresetAgent } = params;

  if (
    persistedIsUserSet &&
    persisted.selectedAgentIds.length > 0 &&
    persisted.mode === 'auto' &&
    generatedAgentIds.length > 0 &&
    persisted.selectedAgentIds.every((id) => generatedAgentIds.includes(id))
  ) {
    return { selection: persisted, isUserSet: true };
  }

  // The course's own roster outranks any carried global choice.
  if (generatedAgentIds.length > 0) {
    return { selection: { mode: 'auto', selectedAgentIds: generatedAgentIds }, isUserSet: false };
  }

  if (persistedIsUserSet && persisted.selectedAgentIds.length > 0) {
    if (persisted.mode === 'preset' && persisted.selectedAgentIds.every(isPresetAgent)) {
      return { selection: persisted, isUserSet: true };
    }
  }

  const cleanIds = stageAgentIds?.filter(isPresetAgent) ?? [];
  return {
    selection: {
      mode: 'preset',
      selectedAgentIds:
        cleanIds.length > 0
          ? cleanIds
          : ['default-1', 'default-2', 'default-3', 'default-4', 'default-5', 'default-6'],
    },
    isUserSet: false,
  };
}
