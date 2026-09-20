/**
 * restoreAgentSelection: a classroom plays ITS OWN roster — the portraits and
 * voice bindings recorded on the document are properties of the course, so a
 * viewer's global preset choice (homepage 预设AI老师与同学) must not override
 * them. A carried preset choice only applies to stages without a roster
 * (legacy preset stages). Stage-derived defaults written by previous
 * classroom loads are NOT user choices and must never carry across stages.
 */
import { describe, it, expect } from 'vitest';
import {
  restoreAgentSelection,
  type AgentSelection,
} from '@/lib/orchestration/registry/agent-selection';

const PRESETS = new Set(['default-1', 'default-2', 'default-3', 'default-4']);
const isPresetAgent = (id: string) => PRESETS.has(id);

describe('restoreAgentSelection', () => {
  it("plays the stage's own roster even when a user-set preset selection is active", () => {
    // The course's recorded cast outranks the viewer's global preset pick —
    // otherwise changing the homepage teacher would restyle every course.
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['default-2', 'default-3'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it('keeps a user-set preset selection on a stage without its own roster', () => {
    const persisted: AgentSelection = {
      mode: 'preset',
      selectedAgentIds: ['default-2', 'default-3'],
    };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: [],
        stageAgentIds: ['default-1'],
        isPresetAgent,
      }),
    ).toEqual({ selection: persisted, isUserSet: true });
  });

  it("keeps a user-set auto selection that is a subset of this stage's generated agents", () => {
    const persisted: AgentSelection = { mode: 'auto', selectedAgentIds: ['gen-b'] };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({ selection: persisted, isUserSet: true });
  });

  it('ignores a stage-derived persisted selection and applies this stage defaults', () => {
    // A previous classroom load wrote {preset, trio} as its fallback; that is
    // not a user choice, so an auto stage must still get its generated agents.
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] },
        persistedIsUserSet: false,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it("resets a stale user-set auto selection (ids from another stage) to this stage's defaults", () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it('falls back to auto defaults when a user-set preset selection contains unknown ids', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['gen-stale', 'default-2'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a'],
        isPresetAgent,
      }),
    ).toEqual({ selection: { mode: 'auto', selectedAgentIds: ['gen-a'] }, isUserSet: false });
  });

  it('falls back to stage preset agents when nothing is generated and nothing was user-set', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        persistedIsUserSet: false,
        generatedAgentIds: [],
        stageAgentIds: ['default-4', 'gen-stale'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'preset', selectedAgentIds: ['default-4'] },
      isUserSet: false,
    });
  });

  it('falls back to the full default lineup when nothing else is valid', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: [] },
        persistedIsUserSet: true,
        generatedAgentIds: [],
        isPresetAgent,
      }),
    ).toEqual({
      selection: {
        mode: 'preset',
        selectedAgentIds: [
          'default-1',
          'default-2',
          'default-3',
          'default-4',
          'default-5',
          'default-6',
        ],
      },
      isUserSet: false,
    });
  });

  it('round-trips A(auto) → B(preset) → A without degrading A to preset agents', () => {
    // Simulates sequential classroom loads with no user interaction: each
    // load persists its result and feeds it into the next load.
    const loadA = () => ({ generatedAgentIds: ['gen-a1', 'gen-a2'], stageAgentIds: undefined });
    const loadB = () => ({ generatedAgentIds: [], stageAgentIds: ['default-1', 'default-2'] });

    let state = {
      selection: { mode: 'auto', selectedAgentIds: [] } as AgentSelection,
      isUserSet: false,
    };
    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadA(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a1', 'gen-a2'] });

    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadB(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({
      mode: 'preset',
      selectedAgentIds: ['default-1', 'default-2'],
    });

    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadA(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a1', 'gen-a2'] });
  });

  it('keeps a user-set preset choice only on roster-less stages through A → B → A', () => {
    // A carries a roster (plays its own cast); B has none (preset pick applies);
    // returning to A plays A's cast again — the carried preset never restyles
    // a roster-carrying course.
    const persisted: AgentSelection = { mode: 'preset', selectedAgentIds: ['default-2'] };
    const visitA = () =>
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a1'],
        isPresetAgent,
      });
    expect(visitA()).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a1'] },
      isUserSet: false,
    });

    const visitB = () =>
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: [],
        stageAgentIds: ['default-1'],
        isPresetAgent,
      });
    expect(visitB()).toEqual({ selection: persisted, isUserSet: true });
    expect(visitA()).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a1'] },
      isUserSet: false,
    });
  });
});
