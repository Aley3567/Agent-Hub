/**
 * 应用数据 store。AppState 的字段与方法签名逐字取自 CONTRACT.md 第 6.2 节，
 * 四个视图代理直接消费，任何增删都会破坏契约。
 *
 * 三条自我约束：
 *   1. 数据只来自 ../api。Rust 侧不可用时 api 层回退到离线示例数据，offline 如实反映，
 *      界面必须据此提示（CONTRACT.md 第 4 节：绝不让假数据冒充真实数据）。
 *   2. error 里存中文原因原文——IPC 返回的错误字符串本来就是给人看的，
 *      这里不包装成「操作失败」这种没有信息量的话（AGENTS.md：错误原样暴露）。
 *   3. 动作方法直通 IPC，成功后自动 refresh 受影响的 key；失败时记进 error 并把异常抛回
 *      调用方，让视图能就地显示原因，绝不静默吞掉。
 *
 * loading / error 的 key：十一个 refresh key（chatProjects 只服务对话视图的项目选择器），
 * 加上动作方法自己的名字（setHidden / setAlias / setOverride / setSlot / setSlotEffort /
 * launch / doctorFixSubagentPins / openPath / revealInFolder / sendChatMessage /
 * selectChatProject / createChatSession / deleteChatSession /
 * setPluginEnabled / createTask / updateTask / deleteTask）。
 *
 * loadedKeys 记录每个 key 是否至少完成过一次加载（成败都算），视图用它区分
 * 「还没加载过」与「加载过但为空」：空态只在后者出现，避免首帧闪空态。
 */
import { create } from 'zustand';
import {
  appEnv,
  chatProjects as chatProjectsIpc,
  createChatSession as createChatSessionIpc,
  createTask as createTaskIpc,
  deleteChatSession as deleteChatSessionIpc,
  deleteTask as deleteTaskIpc,
  doctorFixSubagentPins as fixSubagentPins,
  isOffline,
  launch as launchSession,
  listAccountPools,
  listChannels,
  listChatSessions,
  listHubs,
  listPlugins,
  listTasks,
  openPath as openPathIpc,
  recentErrors,
  recentUsage,
  revealInFolder as revealInFolderIpc,
  runDoctor,
  selectChatProject as selectChatProjectIpc,
  sendChatMessage as sendChatMessageIpc,
  setChannelAlias,
  setChannelHidden,
  setChannelOverride,
  setHubSlot,
  setHubSlotEffort,
  setPluginEnabled as setPluginEnabledIpc,
  updateTask as updateTaskIpc,
  usageSummary,
} from '../api';
import type {
  AccountPool,
  AppEnv,
  Channel,
  ChatMessage,
  ChatProject,
  ChatSession,
  ChatStreamChunk,
  ChatStreamEnd,
  ChatStreamError,
  DoctorCheck,
  Effort,
  ErrorRow,
  HubConfig,
  LaunchResult,
  LaunchTarget,
  NewScheduledTask,
  PluginItem,
  ScheduledTask,
  SlotName,
  UsageRow,
  UsageSummary,
} from '../types/contract';

export interface AppState {
  channels: Channel[];
  hubs: HubConfig[];
  pools: AccountPool[];
  usage: UsageSummary | null;
  recentUsage: UsageRow[];
  errors: ErrorRow[];
  doctor: DoctorCheck[];
  chatSessions: ChatSession[];
  /** `~/.claude/projects` 下可回放的历史项目 */
  chatProjects: ChatProject[];
  /**
   * 在途流式缓冲。sendChatMessage 起头创建（requestId 为空串，等首个增量认领归属），
   * 终态或失败时收掉；非 null 就等于「这条会话上有一轮真实流在跑」。
   * 界面只渲染它，不再自己造流式节奏（假流式已删）。
   */
  chatStream: { sessionId: string; requestId: string; text: string } | null;
  /**
   * 事件通道最近一次的终态。sendChatMessage 的 catch 靠它判断这次失败是否已经由事件
   * 通道交代过（错误事件已经报过原文；截断的说明已由 Rust 落盘成 system 消息），
   * 避免同一个原因既弹 toast 又弹一遍。
   */
  chatStreamTerminal: { sessionId: string; reason: 'stop' | 'truncated' | 'error' } | null;
  plugins: PluginItem[];
  tasks: ScheduledTask[];
  env: AppEnv | null;
  offline: boolean;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  /** 每个 key 是否至少完成过一次加载（成败都算）；空态只准在它之后出现 */
  loadedKeys: Record<string, boolean>;
  /** 成败判别：refresh 自身永不抛出，await 之后读 error[key]，null 即成功 */
  refresh(
    key:
      | 'channels'
      | 'hubs'
      | 'pools'
      | 'usage'
      | 'errors'
      | 'doctor'
      | 'env'
      | 'chat'
      | 'chatProjects'
      | 'plugins'
      | 'tasks',
  ): Promise<void>;
  refreshAll(): Promise<void>;
  setHidden(id: string, hidden: boolean, appType?: Channel['appType']): Promise<void>;
  setAlias(id: string, alias: string | null, appType?: Channel['appType']): Promise<void>;
  setOverride(id: string, model: string | null, effort: Effort | null, appType?: Channel['appType']): Promise<void>;
  setSlot(hub: string, slot: SlotName, channel: string | null, model: string | null): Promise<void>;
  setSlotEffort(hub: string, slot: SlotName, effort: Effort | null): Promise<void>;
  launch(target: LaunchTarget): Promise<LaunchResult>;
  /**
   * 发一条消息。返回的只是最终副本：正文由 ChatStreamChunk 事件增量渲染，
   * 失败由 `chat-stream-error` 事件报原文——调用方不要用返回值驱动界面。
   * 成功后自动 refresh('chat')
   */
  sendChatMessage(sessionId: string, content: string): Promise<ChatMessage>;
  /** 选中要回放的历史项目；成功后自动 refresh('chatProjects') 与 refresh('chat') */
  selectChatProject(key: string): Promise<void>;
  /** 新建本地会话，hubName 为 null 表示默认 hub；成功后自动 refresh('chat') */
  createChatSession(hubName: string | null, channelId: string): Promise<ChatSession>;
  /** 只对本地会话有效（历史只读，删不掉）；成功后自动 refresh('chat') */
  deleteChatSession(id: string): Promise<void>;
  /**
   * 收下一段流式增量。requestId 与当前在途流不一致时丢弃——切换会话、重开一条之后
   * 才到的增量属于作废的流，不许再写状态。
   */
  appendChatDelta(chunk: ChatStreamChunk): void;
  /** 终态收尾：过期的终态整体作废，命中的则记终态并收掉缓冲 */
  endChatStream(end: ChatStreamEnd): void;
  /**
   * 失败收尾：记终态并清空缓冲。失败绝不留在消息流里冒充一条回复。
   * `error` 带着这次发送的 sessionId / requestId，先过一遍归因守卫——不属于当前在途流的
   * 错误（别的会话、已交代过的旧流、requestId 对不上）整体作废，返回 false 让调用方连
   * toast 也不弹。返回 true = 这条失败属于在途流，缓冲已收掉、终态已记。
   */
  failChatStream(error: ChatStreamError): boolean;
  /** 成功后自动 refresh('plugins')；渠道级只读项会抛中文错误 */
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  /** 成功后自动 refresh('tasks') */
  createTask(task: NewScheduledTask): Promise<ScheduledTask>;
  /** patch 只认 enabled / schedule / name；成功后自动 refresh('tasks') */
  updateTask(id: string, patch: { enabled?: boolean; schedule?: string; name?: string }): Promise<ScheduledTask>;
  /** 成功后自动 refresh('tasks') */
  deleteTask(id: string): Promise<void>;
  doctorFixSubagentPins(): Promise<DoctorCheck[]>;
  openPath(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  usageRange: { fromTs: number; toTs: number; granularity: 'hour' | 'day'; preset?: 'today'|'week'|'month'|'custom' };
  setUsageRange(r: Partial<AppState['usageRange']>): void;
}

/** refresh 接受的 key，从契约方法签名上取，避免两处写同一个联合类型而走神 */
export type RefreshKey = Parameters<AppState['refresh']>[0];

/** refreshAll 的顺序：env 先行，后面的视图文案里要用到路径 */
export const REFRESH_KEYS: RefreshKey[] = [
  'env',
  'channels',
  'hubs',
  'pools',
  'usage',
  'errors',
  'doctor',
  'chat',
  'chatProjects',
  'plugins',
  'tasks',
];

/** 最近记录的默认条数：够诊断视图翻几屏，又不至于把整条 journal 拉进内存 */
const RECENT_LIMIT = 200;

const SECONDS_PER_DAY = 86400;

/** 本地时区今天零点的 unix 秒。StatusBar 的「今日 token」与默认时间窗都用它 */
export function startOfTodaySeconds(): number {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
}

/** 默认时间窗：最近 7 天（含今天），按天聚合 */
function defaultUsageRange(): AppState['usageRange'] {
  return {
    fromTs: startOfTodaySeconds() - 6 * SECONDS_PER_DAY,
    toTs: Math.floor(Date.now() / 1000),
    granularity: 'day',
    preset: 'week',
  };
}

/**
 * 刷新 usage 前滚动时间窗。预设窗口（今天/7 天/30 天）的 toTs 在选定时就固定为
 * 「当时的 now」，journal 是追加型，新数据 ts 全部大于它——不滚窗的话自动刷新
 * 在数学上不可能改变聚合结果，还会制造「明细表在涨、KPI 与走势图不动」的双源
 * 失配。起点命中任一预设就把它滚成当下（起点零点对齐不变，跨零点后自动滚进
 * 新一天）；不命中（自定义窗口）说明用户钉死了这段历史，原样保留。
 */
function rollUsageRange(range: AppState['usageRange']): AppState['usageRange'] {
  if(range.preset==='custom'||!range.preset)return range;
  const now=Math.floor(Date.now()/1000);
  const days=range.preset==='week'?7:30;
  const start=new Date();start.setHours(0,0,0,0);start.setDate(start.getDate()-(days-1));
  return {...range,fromTs:range.preset==='today'?now-86400:Math.floor(start.getTime()/1000),toTs:now};
}

/**
 * 取错误的人话文本。IPC 的 reject 值本身就是中文字符串，原样返回；
 * 其余情况尽量不丢信息，但不编造「未知错误」之外的解释。
 */
export function errorText(cause: unknown): string {
  if (typeof cause === 'string' && cause !== '') return cause;
  if (cause instanceof Error && cause.message !== '') return cause.message;
  if (cause === null || cause === undefined) return '调用没有返回原因，请查看应用日志';
  return String(cause);
}

/** 默认 hub：优先 isDefault，其次列表首个。一个都没有时返回 null，界面显示「未配置」 */
export function pickDefaultHub(hubs: HubConfig[]): HubConfig | null {
  return hubs.find((hub) => hub.isDefault) ?? hubs[0] ?? null;
}

export const useApp = create<AppState>()((set, get) => {
  /** 每个 refresh key 的请求序号：慢的旧响应后到时序号已过期，结果作废丢弃，
   *  不许把旧 range 的数据盖在新 range 的状态上——界面顶着新标签显示旧数据
   *  就是失败被伪装成成功。 */
  const seq: Record<string, number> = {};

  /**
   * 已经发过终态（end / fail）的流。事件通道与命令回执是两条通道，回执先到、
   * 这一轮的尾部增量后到是可能的；增量认领归属的那个窗口（requestId 还是空串）里
   * 尤其挡得住它——否则上一轮的迟到增量会冒充新一轮的开头。
   */
  const retiredRequests = new Set<string>();
  const retire = (requestId: string): void => {
    if (requestId === '') return;
    // 只需要记住最近这几条：能造成错写的是紧邻的上一轮，不是很久以前的流
    if (retiredRequests.size >= 64) retiredRequests.clear();
    retiredRequests.add(requestId);
  };

  const begin = (key: string): number => {
    const ticket = (seq[key] ?? 0) + 1;
    seq[key] = ticket;
    set((state) => ({
      loading: { ...state.loading, [key]: true },
      error: { ...state.error, [key]: null },
    }));
    return ticket;
  };

  /** begin 时取的序号已过期（期间又有新请求）则丢弃结果：过期请求既不写数据，
   *  也不碰 loading/error——那些归接管了状态的新请求管。 */
  const isStale = (key: string, ticket: number): boolean => seq[key] !== ticket;

  const finish = (key: string, ticket: number, reason: string | null): void => {
    if (isStale(key, ticket)) return;
    set((state) => ({
      loading: { ...state.loading, [key]: false },
      error: { ...state.error, [key]: reason },
      loadedKeys: { ...state.loadedKeys, [key]: true },
      offline: isOffline,
    }));
  };

  /** 动作方法的公共流程：直通 IPC → 成功后刷新受影响的 key → 失败记原文并抛回 */
  const runAction = async (key: string, call: () => Promise<void>, after: RefreshKey[]): Promise<void> => {
    const ticket = begin(key);
    try {
      await call();
      finish(key, ticket, null);
    } catch (cause) {
      finish(key, ticket, errorText(cause));
      throw cause;
    }
    await Promise.all(after.map((next) => get().refresh(next)));
  };

  /** 与 runAction 同一流程，但动作本身有返回值要交还调用方（如 sendChatMessage 的回复本体） */
  const runActionResult = async <T>(key: string, call: () => Promise<T>, after: RefreshKey[]): Promise<T> => {
    const ticket = begin(key);
    let result: T;
    try {
      result = await call();
      finish(key, ticket, null);
    } catch (cause) {
      finish(key, ticket, errorText(cause));
      throw cause;
    }
    await Promise.all(after.map((next) => get().refresh(next)));
    return result;
  };

  return {
    channels: [],
    hubs: [],
    pools: [],
    usage: null,
    recentUsage: [],
    errors: [],
    doctor: [],
    chatSessions: [],
    chatProjects: [],
    chatStream: null,
    chatStreamTerminal: null,
    plugins: [],
    tasks: [],
    env: null,
    offline: isOffline,
    loading: {},
    error: {},
    loadedKeys: {},
    usageRange: defaultUsageRange(),

    refresh: async (key) => {
      const ticket = begin(key);
      try {
        switch (key) {
          case 'channels': {
            const value = await listChannels();
            if (!isStale(key, ticket)) set({ channels: value });
            break;
          }
          case 'hubs': {
            const value = await listHubs();
            if (!isStale(key, ticket)) set({ hubs: value });
            break;
          }
          case 'pools': {
            const value = await listAccountPools();
            if (!isStale(key, ticket)) set({ pools: value });
            break;
          }
          case 'usage': {
            // 请求前滚窗（rollUsageRange 注释）：预设窗口的 toTs 固定在选定时刻，
            // 不滚的话追加型 journal 的新数据全部落在窗外，自动刷新对聚合零效果
            const rolled = rollUsageRange(get().usageRange);
            const [summary, rows] = await Promise.all([
              usageSummary(rolled.fromTs, rolled.toTs, rolled.granularity),
              recentUsage(5000, null, rolled.fromTs, rolled.toTs),
            ]);
            if (!isStale(key, ticket)) set({ usage: summary, recentUsage: rows, usageRange: rolled });
            break;
          }
          case 'errors': {
            const value = await recentErrors(RECENT_LIMIT);
            if (!isStale(key, ticket)) set({ errors: value });
            break;
          }
          case 'doctor': {
            const value = await runDoctor();
            if (!isStale(key, ticket)) set({ doctor: value });
            break;
          }
          case 'chat': {
            const value = await listChatSessions();
            if (!isStale(key, ticket)) set({ chatSessions: value });
            break;
          }
          case 'chatProjects': {
            const value = await chatProjectsIpc();
            if (!isStale(key, ticket)) set({ chatProjects: value });
            break;
          }
          case 'plugins': {
            const value = await listPlugins();
            if (!isStale(key, ticket)) set({ plugins: value });
            break;
          }
          case 'tasks': {
            const value = await listTasks();
            if (!isStale(key, ticket)) set({ tasks: value });
            break;
          }
          case 'env': {
            const value = await appEnv();
            if (!isStale(key, ticket)) set({ env: value });
            break;
          }
        }
        finish(key, ticket, null);
      } catch (cause) {
        // 单个 key 失败不影响其他 key：原因记在 error[key]，视图各自呈现
        finish(key, ticket, errorText(cause));
      }
    },

    refreshAll: async () => {
      await Promise.all(REFRESH_KEYS.map((key) => get().refresh(key)));
    },

    setHidden: (id, hidden, appType) => runAction('setHidden', () => setChannelHidden(id, hidden, appType), ['channels']),

    setAlias: (id, alias, appType) => runAction('setAlias', () => setChannelAlias(id, alias, appType), ['channels']),

    setOverride: (id, model, effort, appType) =>
      runAction('setOverride', () => setChannelOverride(id, model, effort, appType), ['channels']),

    setSlot: (hub, slot, channel, model) =>
      runAction('setSlot', () => setHubSlot(hub, slot, channel, model), ['hubs']),

    setSlotEffort: (hub, slot, effort) =>
      runAction('setSlotEffort', () => setHubSlotEffort(hub, slot, effort), ['hubs']),

    launch: async (target) => {
      const ticket = begin('launch');
      let result: LaunchResult;
      try {
        result = await launchSession(target);
      } catch (cause) {
        finish('launch', ticket, errorText(cause));
        throw cause;
      }
      // ok 为 false 也要留痕：失败不许伪装成成功（AGENTS.md）
      finish('launch', ticket, result.ok ? null : result.message);
      if (target.kind !== 'channel') {
        // 起的是 hub 或槽位会话，hub 的运行状态可能已经变了
        await get().refresh('hubs');
      }
      return result;
    },

    sendChatMessage: (sessionId, content) => {
      // 起头：这次尝试一律从「清空的缓冲、没有终态」开始。缓冲此刻就存在，只是正文还是
      // 空串——界面据此进「流中」态（等首个增量的光标就是它），正文由 chat-stream 事件填。
      set({ chatStream: { sessionId, requestId: '', text: '' }, chatStreamTerminal: null });
      return runActionResult('sendChatMessage', () => sendChatMessageIpc(sessionId, content), ['chat']).finally(() => {
        // 命令回执到位 = 这轮一定结束了（Rust 侧流完才返回）。窗口隐藏时 end 事件可能漏投，
        // 靠这里兜底收掉缓冲，免得界面永远停在「流中」。终态只由真实事件写，这里不编。
        const current = get().chatStream;
        if (current !== null && current.sessionId === sessionId) set({ chatStream: null });
      });
    },

    selectChatProject: (key) => runAction('selectChatProject', () => selectChatProjectIpc(key), ['chatProjects', 'chat']),

    createChatSession: (hubName, channelId) =>
      runActionResult('createChatSession', () => createChatSessionIpc(hubName, channelId), ['chat']),

    deleteChatSession: (id) => runAction('deleteChatSession', () => deleteChatSessionIpc(id), ['chat']),

    appendChatDelta: (chunk) => {
      const current = get().chatStream;
      if (current === null) return; // 没有在途流：迟到的增量不写状态
      if (current.sessionId !== chunk.sessionId) return; // 别的会话的流
      if (retiredRequests.has(chunk.requestId)) return; // 已经发过终态的旧流
      if (current.requestId === '') {
        // 首个增量认领这次尝试：Rust 的 requestId 只出现在事件里，不在命令回执里
        set({ chatStream: { ...current, requestId: chunk.requestId, text: current.text + chunk.delta } });
        return;
      }
      if (current.requestId !== chunk.requestId) return; // 作废的流不许再写状态
      set({ chatStream: { ...current, text: current.text + chunk.delta } });
    },

    endChatStream: (end) => {
      const current = get().chatStream;
      if (current === null) return; // 缓冲已收掉（失败先到）：迟到的终态不写状态
      if (current.sessionId !== end.sessionId) return; // 换过会话：这条终态不属于当前在途流
      if (current.requestId !== '' && current.requestId !== end.requestId) return; // 重开过：同上
      retire(current.requestId);
      // 缓冲在这里收掉：Rust 已把正文落盘，refresh('chat') 一到就由真值接管
      set({ chatStream: null, chatStreamTerminal: { sessionId: end.sessionId, reason: end.reason } });
    },

    failChatStream: (error) => {
      const current = get().chatStream;
      // 没有在途流时不动状态：迟到的错误事件不该覆盖新一轮的终态记录
      if (current === null) return false;
      if (current.sessionId !== error.sessionId) return false; // 别的会话的流
      if (retiredRequests.has(error.requestId)) return false; // 已经发过终态的旧流
      // 与 appendChatDelta 同一套口径：requestId 还是空串 = 这次尝试还没被认领，错误属于它
      // （命令回执先到的失败走的就是这条）；认领过了就必须逐字对上，否则是作废流的迟到错误。
      // 这一条正是「旧流的错误在新流期间才到、误收新流缓冲」的挡板。
      if (current.requestId !== '' && current.requestId !== error.requestId) return false;
      // 认领这次尝试的 id，同一条错误再来就被 retiredRequests 挡住
      retire(current.requestId === '' ? error.requestId : current.requestId);
      set({ chatStream: null, chatStreamTerminal: { sessionId: error.sessionId, reason: 'error' } });
      return true;
    },

    setPluginEnabled: (id, enabled) =>
      runAction('setPluginEnabled', () => setPluginEnabledIpc(id, enabled), ['plugins']),

    createTask: (task) => runActionResult('createTask', () => createTaskIpc(task), ['tasks']),

    updateTask: (id, patch) => runActionResult('updateTask', () => updateTaskIpc(id, patch), ['tasks']),

    deleteTask: (id) => runAction('deleteTask', () => deleteTaskIpc(id), ['tasks']),

    doctorFixSubagentPins: async () => {
      const ticket = begin('doctorFixSubagentPins');
      let checks: DoctorCheck[];
      try {
        checks = await fixSubagentPins();
      } catch (cause) {
        finish('doctorFixSubagentPins', ticket, errorText(cause));
        throw cause;
      }
      finish('doctorFixSubagentPins', ticket, null);
      // 返回值就是修复后的完整体检结果，直接落库并视作 doctor 完成过一次加载，省一次重复体检
      set((state) => ({ doctor: checks, loadedKeys: { ...state.loadedKeys, doctor: true } }));
      return checks;
    },

    openPath: (path) => runAction('openPath', () => openPathIpc(path), []),

    revealInFolder: (path) => runAction('revealInFolder', () => revealInFolderIpc(path), []),

    setUsageRange: (r) => {
      set((state) => ({ usageRange: { ...state.usageRange, ...r } }));
      // 时间窗变了，聚合结果必然过期，立刻重算；调用方按契约拿到的是 void
      void get().refresh('usage');
    },
  };
});
