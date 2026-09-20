/**
 * Agent Registry Store
 * Manages configurable AI agents using Zustand with localStorage persistence
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentConfig } from './types';
import { getActionsForRole } from './types';
import { isKnownTTSProviderId } from '@/lib/audio/constants';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { USER_AVATAR } from '@/lib/types/roundtable';
import type { Participant, ParticipantRole } from '@/lib/types/roundtable';
import { useUserProfileStore } from '@/lib/store/user-profile';
import type { AgentInfo } from '@openmaic/generation';

interface AgentRegistryState {
  agents: Record<string, AgentConfig>; // Map of agentId -> config

  // Actions
  addAgent: (agent: AgentConfig) => void;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void;
  deleteAgent: (id: string) => void;
  getAgent: (id: string) => AgentConfig | undefined;
  listAgents: () => AgentConfig[];
}

// Action types available to agents
const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
];

const SLIDE_ACTIONS = ['spotlight', 'laser', 'play_video'];

// Default agents - always available on both server and client
const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  'default-1': {
    id: 'default-1',
    name: 'AI teacher',
    role: 'teacher',
    persona: `你是这间课堂的主讲老师。你讲课清晰、温暖,对所教怀有真诚的热情。

你的教学风格:
- 循序渐进地讲解概念,从学生已知的内容出发逐步搭建
- 善用生动的类比、真实的例子和直观的演示,把抽象概念讲得具体可感
- 适时停下来确认理解——多提问,而不是一味灌输
- 灵活调整节奏:难点放慢,熟悉的内容加快
- 学生发言时点名鼓励,纠正错误时不让学生难堪

你可以用聚光灯或激光笔指向幻灯片上的元素,也可以用白板进行手绘讲解。把这些动作自然地融入教学流程,不要播报动作,直接讲课即可。

语气:专业而亲和,耐心、善于鼓励,真心在意学生是否听懂。`,
    avatar: '/avatars/teacher-3.png',
    color: '#3b82f6',
    allowedActions: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-2': {
    id: 'default-2',
    name: 'AI助教',
    role: 'assistant',
    persona: `你是课堂助教。你配合主讲老师查漏补缺、解答疑问,确保没有学生掉队。

你的风格:
- 学生困惑时,用更简单的说法或换个角度重新解释老师讲的内容
- 给出具体的例子,尤其是贴近生活、让概念变得可感的日常实例
- 主动补充老师可能略过的背景知识
- 复杂内容讲完后,帮忙归纳要点
- 需要时可以用白板快速画图说明

你扮演的是辅助角色——不会抢走课堂,但会让每个人都跟上。

语气:友好、温暖、接地气,像一位一点就通又乐意帮忙的学长学姐。`,
    avatar: '/avatars/assist-3.png',
    color: '#10b981',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-3': {
    id: 'default-3',
    name: '小趣(趣梗搭子)',
    role: 'student',
    persona: `你是班里的趣梗搭子——最抢眼的那位同学。你用机智的吐槽、俏皮的观察和对课程内容出人意料的解读,给课堂带来活力和笑声。

你的个性:
- 爱开玩笑,能把正在讨论的话题幽默地串联起来
- 有时会夸张地表现“没听懂”来制造喜剧效果,但其实一直在认真听讲
- 善用流行文化、梗和搞笑类比
- 你不捣乱——你的幽默让课堂更有趣,也让大家放松
- 偶尔还能在玩笑中冒出颇有见地的观点

你负责让气氛轻松。课堂太沉闷时,你就是那个带动气氛的人;但到了严肃时刻,你也懂得收着点。

语气:俏皮、活力足、有点小机灵。说话随意自然,像和朋友聊天。回复要短——一两句的快反应,不要长篇大论。

你的名字叫小趣。老师和同学称呼你时永远叫“小趣”,绝不叫“同学”或编造别的名字。`,
    avatar: '/avatars/student-1.png',
    color: '#f59e0b',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-4': {
    id: 'default-4',
    name: '小奇(好奇同学)',
    role: 'student',
    persona: `你是好奇心无限的同学。你永远有问题——而且你的问题常常把全班的思考引向更深处。

你的个性:
- 不停地问“为什么”和“怎么会这样”——不是故意捣乱,而是真心想弄明白
- 能注意到别人忽略的细节,喜欢追问边界情况、例外和与其他知识的联系
- 敢于直接说“我没听懂”——你的坦诚帮到了那些不好意思提问的同学
- 学到新东西时会兴奋,并且毫不掩饰地表达出来
- 有时会把问题问到稍超前的地方,拉着讨论往前走

你代表着真诚的好奇心。你的提问让老师的讲解对所有人都更有价值。

语气:急切、热情,偶尔带着困惑。说话像第一次发现新事物那样兴奋。提问要简洁直接。

你的名字叫小奇。老师和同学称呼你时永远叫“小奇”,绝不叫“同学”或编造别的名字。`,
    avatar: '/avatars/student-2.png',
    color: '#ec4899',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-5': {
    id: 'default-5',
    name: '小勤(勤奋记录员)',
    role: 'student',
    persona: `你是班里勤奋的记录员。你认真听讲、善于整理,喜欢把结构清晰的总结分享给大家。

你的个性:
- 天生擅长把复杂的讲解提炼成条理清晰的要点
- 每讲完一个关键概念,你会为全班做个简短的总结或回顾
- 常用白板记下关键公式、定义或结构化提纲
- 注意到有重要内容可能被大家漏掉时,你会及时提醒
- 偶尔会请老师再澄清一下,确保笔记准确

你是考试时人人都想坐在旁边的同学,你的笔记堪称传奇。

语气:条理清晰、乐于助人、带点学霸气质。说话清楚准确。分享笔记时用结构化的形式——编号列表、加粗关键术语、清晰的标题。

你的名字叫小勤。老师和同学称呼你时永远叫“小勤”,绝不叫“同学”或编造别的名字。`,
    avatar: '/avatars/student-3.png',
    color: '#06b6d4',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-6': {
    id: 'default-6',
    name: '小思(学习委员)',
    role: 'student',
    persona: `你是班里的学习委员——全班思维最严谨的人。当别人还在理解基础时,你已经在建立联系、质疑假设、推演后果了。

你的个性:
- 擅长把当前话题与其他领域或概念出人意料地联系起来
- 会有礼有节地挑战观点——“可如果……呢?”“这会不会和……矛盾?”是你的口头禅
- 思考更大的图景:哲学意涵、现实后果、伦理维度
- 偶尔故意唱反调,把讨论推向更深处
- 你的发言常常引发全班最精彩的讨论

你不像别人那样频繁发言,但一开口就能改变讨论的方向。你重视深度胜过广度。

语气:深思、沉稳、求知欲强。发言前会先停顿,句子经过斟酌、有分量。提出的问题要能让所有人停下来思考。

你的名字叫小思。老师和同学称呼你时永远叫“小思”,绝不叫“同学”或编造别的名字。`,
    avatar: '/avatars/student-4.png',
    color: '#8b5cf6',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 6,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
};

/**
 * Return the built-in default agents as lightweight AgentInfo objects
 * suitable for the generation pipeline (no UI-only fields like avatar/color).
 */
export function getDefaultAgents(): AgentInfo[] {
  return Object.values(DEFAULT_AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export const useAgentRegistry = create<AgentRegistryState>()(
  persist(
    (set, get) => ({
      // Initialize with default agents so they're available on server
      agents: { ...DEFAULT_AGENTS },

      addAgent: (agent) =>
        set((state) => ({
          agents: { ...state.agents, [agent.id]: agent },
        })),

      updateAgent: (id, updates) =>
        set((state) => ({
          agents: {
            ...state.agents,
            [id]: { ...state.agents[id], ...updates, updatedAt: new Date() },
          },
        })),

      deleteAgent: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.agents;
          return { agents: rest };
        }),

      getAgent: (id) => get().agents[id],

      listAgents: () => Object.values(get().agents),
    }),
    {
      name: 'agent-registry-storage',
      version: 11, // Bumped: add voiceOverrides field to AgentConfig
      migrate: (persistedState: unknown) => persistedState,
      // Generated agents are single-sourced on the stage document and rebuilt
      // from it on every classroom load — keep them out of the localStorage
      // snapshot entirely. The merge filter below stays as defense in depth
      // for snapshots written before this partialize existed.
      partialize: (state) => ({
        agents: Object.fromEntries(
          Object.entries(state.agents).filter(([, agent]) => !agent.isGenerated),
        ),
      }),
      // Merge persisted state with default agents
      // Default agents always use code-defined values (not cached)
      // Custom agents use persisted values
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Record<string, unknown> | undefined;
        const persistedAgents = (persisted?.agents || {}) as Record<string, AgentConfig>;
        const mergedAgents: Record<string, AgentConfig> = { ...DEFAULT_AGENTS };

        // Only preserve non-default, non-generated (custom) agents from cache
        // Generated agents are loaded on-demand from IndexedDB per stage
        for (const [id, agent] of Object.entries(persistedAgents)) {
          const agentConfig = agent as AgentConfig;
          if (!id.startsWith('default-') && !agentConfig.isGenerated) {
            mergedAgents[id] = agentConfig;
          }
        }

        return {
          ...currentState,
          agents: mergedAgents,
        };
      },
    },
  ),
);

/**
 * Convert agents to roundtable participants
 * Maps agent roles to participant roles for the UI
 * @param t - i18n translation function for localized display names
 */
export function agentsToParticipants(
  agentIds: string[],
  t?: (key: string) => string,
): Participant[] {
  const registry = useAgentRegistry.getState();
  const participants: Participant[] = [];
  let hasTeacher = false;

  // Resolve agents and sort: teacher first (by role then priority desc)
  const resolved = agentIds
    .map((id) => registry.getAgent(id))
    .filter((a): a is AgentConfig => a != null);
  resolved.sort((a, b) => {
    if (a.role === 'teacher' && b.role !== 'teacher') return -1;
    if (a.role !== 'teacher' && b.role === 'teacher') return 1;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  for (const agent of resolved) {
    // Map agent role to participant role:
    // The first agent with role "teacher" becomes the left-side teacher.
    // If no agent has role "teacher", the highest-priority agent becomes teacher.
    let role: ParticipantRole = 'student';
    if (!hasTeacher) {
      role = 'teacher';
      hasTeacher = true;
    }

    // Use i18n name for default agents, fall back to registry name
    const i18nName = t?.(`settings.agentNames.${agent.id}`);
    const displayName =
      i18nName && i18nName !== `settings.agentNames.${agent.id}` ? i18nName : agent.name;

    participants.push({
      id: agent.id,
      name: displayName,
      role,
      avatar: agent.avatar,
      isOnline: true,
      isSpeaking: false,
    });
  }

  // Always add user participant — use profile store when available
  const userProfile = useUserProfileStore.getState();
  const userName = userProfile.nickname || t?.('common.you') || 'You';
  const userAvatar = userProfile.avatar || USER_AVATAR;

  participants.push({
    id: 'user-1',
    name: userName,
    role: 'user',
    avatar: userAvatar,
    isOnline: true,
    isSpeaking: false,
  });

  return participants;
}

/**
 * Replace the registry's generated agents with the given stage roster.
 *
 * In-memory registry side effect: the persisted source of truth for the
 * roster is `stage.generatedAgentConfigs` on the stage document, and callers
 * persist it through the document path — the registry's own localStorage
 * snapshot excludes generated agents (see the persist `partialize` above), so
 * nothing written here becomes durable.
 * Clears previously loaded generated agents first (even when the new roster is
 * empty) so a prior classroom's roster cannot leak into the current one.
 * The contract keeps `voiceConfig.providerId` an open string; a binding whose
 * provider is not registered in this app is dropped here (the agent keeps its
 * voiceDesign, and the TTS path falls back at call time).
 * Returns the applied agent IDs.
 */
export function applyGeneratedAgentsToRegistry(
  stageId: string,
  agents: ReadonlyArray<GeneratedAgentConfig>,
): string[] {
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) registry.deleteAgent(agent.id);
  }

  const now = Date.now();
  const ids: string[] = [];
  for (const agent of agents) {
    const { voiceConfig, ...rest } = agent;
    registry.addAgent({
      ...rest,
      allowedActions: getActionsForRole(agent.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: stageId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ...(voiceConfig && isKnownTTSProviderId(voiceConfig.providerId)
        ? {
            voiceConfig: {
              providerId: voiceConfig.providerId,
              ...(voiceConfig.modelId ? { modelId: voiceConfig.modelId } : {}),
              voiceId: voiceConfig.voiceId,
            },
          }
        : {}),
    });
    ids.push(agent.id);
  }

  // Eager warm-up: pre-register each generated agent's auto voice so the first
  // spoken line is already stable. Same idempotent ensure as the TTS path;
  // fire-and-forget. Dynamic import keeps this client-only dep out of the
  // server-importable store module.
  if (ids.length > 0 && typeof window !== 'undefined') {
    void import('@/lib/audio/agent-voice')
      .then((m) => m.warmUpAgentVoices(registry.listAgents().filter((a) => a.isGenerated)))
      .catch(() => undefined);
  }

  return ids;
}
