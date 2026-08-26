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
 * loading / error 的 key：十个 refresh key，加上动作方法自己的名字
 * （setHidden / setAlias / setOverride / setSlot / setSlotEffort / launch /
 * doctorFixSubagentPins / openPath / revealInFolder / sendChatMessage /
 * setPluginEnabled / createTask / updateTask / deleteTask）。
 *
 * loadedKeys 记录每个 key 是否至少完成过一次加载（成败都算），视图用它区分
 * 「还没加载过」与「加载过但为空」：空态只在后者出现，避免首帧闪空态。
 */
import { create } from 'zustand';
import {
  appEnv,
  createTask as createTaskIpc,
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
  ChatSession,
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
    key: 'channels' | 'hubs' | 'pools' | 'usage' | 'errors' | 'doctor' | 'env' | 'chat' | 'plugins' | 'tasks',
  ): Promise<void>;
  refreshAll(): Promise<void>;
  setHidden(id: string, hidden: boolean): Promise<void>;
  setAlias(id: string, alias: string | null): Promise<void>;
  setOverride(id: string, model: string | null, effort: Effort | null): Promise<void>;
  setSlot(hub: string, slot: SlotName, channel: string | null, model: string | null): Promise<void>;
  setSlotEffort(hub: string, slot: SlotName, effort: Effort | null): Promise<void>;
  launch(target: LaunchTarget): Promise<LaunchResult>;
  /** 发送后自动 refresh('chat')，返回值是演示回复本体（用户消息已追加进会话） */
  sendChatMessage(sessionId: string, content: string): Promise<ChatMessage>;
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
  usageRange: { fromTs: number; toTs: number; granularity: 'hour' | 'day' };
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
  };
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
  const begin = (key: string): void => {
    set((state) => ({
      loading: { ...state.loading, [key]: true },
      error: { ...state.error, [key]: null },
    }));
  };

  const finish = (key: string, reason: string | null): void => {
    set((state) => ({
      loading: { ...state.loading, [key]: false },
      error: { ...state.error, [key]: reason },
      loadedKeys: { ...state.loadedKeys, [key]: true },
      offline: isOffline,
    }));
  };

  /** 动作方法的公共流程：直通 IPC → 成功后刷新受影响的 key → 失败记原文并抛回 */
  const runAction = async (key: string, call: () => Promise<void>, after: RefreshKey[]): Promise<void> => {
    begin(key);
    try {
      await call();
      finish(key, null);
    } catch (cause) {
      finish(key, errorText(cause));
      throw cause;
    }
    await Promise.all(after.map((next) => get().refresh(next)));
  };

  /** 与 runAction 同一流程，但动作本身有返回值要交还调用方（如 sendChatMessage 的回复本体） */
  const runActionResult = async <T>(key: string, call: () => Promise<T>, after: RefreshKey[]): Promise<T> => {
    begin(key);
    let result: T;
    try {
      result = await call();
      finish(key, null);
    } catch (cause) {
      finish(key, errorText(cause));
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
    plugins: [],
    tasks: [],
    env: null,
    offline: isOffline,
    loading: {},
    error: {},
    loadedKeys: {},
    usageRange: defaultUsageRange(),

    refresh: async (key) => {
      begin(key);
      try {
        switch (key) {
          case 'channels':
            set({ channels: await listChannels() });
            break;
          case 'hubs':
            set({ hubs: await listHubs() });
            break;
          case 'pools':
            set({ pools: await listAccountPools() });
            break;
          case 'usage': {
            const range = get().usageRange;
            const [summary, rows] = await Promise.all([
              usageSummary(range.fromTs, range.toTs, range.granularity),
              recentUsage(RECENT_LIMIT),
            ]);
            set({ usage: summary, recentUsage: rows });
            break;
          }
          case 'errors':
            set({ errors: await recentErrors(RECENT_LIMIT) });
            break;
          case 'doctor':
            set({ doctor: await runDoctor() });
            break;
          case 'chat':
            set({ chatSessions: await listChatSessions() });
            break;
          case 'plugins':
            set({ plugins: await listPlugins() });
            break;
          case 'tasks':
            set({ tasks: await listTasks() });
            break;
          case 'env':
            set({ env: await appEnv() });
            break;
        }
        finish(key, null);
      } catch (cause) {
        // 单个 key 失败不影响其他 key：原因记在 error[key]，视图各自呈现
        finish(key, errorText(cause));
      }
    },

    refreshAll: async () => {
      await Promise.all(REFRESH_KEYS.map((key) => get().refresh(key)));
    },

    setHidden: (id, hidden) => runAction('setHidden', () => setChannelHidden(id, hidden), ['channels']),

    setAlias: (id, alias) => runAction('setAlias', () => setChannelAlias(id, alias), ['channels']),

    setOverride: (id, model, effort) =>
      runAction('setOverride', () => setChannelOverride(id, model, effort), ['channels']),

    setSlot: (hub, slot, channel, model) =>
      runAction('setSlot', () => setHubSlot(hub, slot, channel, model), ['hubs']),

    setSlotEffort: (hub, slot, effort) =>
      runAction('setSlotEffort', () => setHubSlotEffort(hub, slot, effort), ['hubs']),

    launch: async (target) => {
      begin('launch');
      let result: LaunchResult;
      try {
        result = await launchSession(target);
      } catch (cause) {
        finish('launch', errorText(cause));
        throw cause;
      }
      // ok 为 false 也要留痕：失败不许伪装成成功（AGENTS.md）
      finish('launch', result.ok ? null : result.message);
      if (target.kind !== 'channel') {
        // 起的是 hub 或槽位会话，hub 的运行状态可能已经变了
        await get().refresh('hubs');
      }
      return result;
    },

    sendChatMessage: (sessionId, content) =>
      runActionResult('sendChatMessage', () => sendChatMessageIpc(sessionId, content), ['chat']),

    setPluginEnabled: (id, enabled) =>
      runAction('setPluginEnabled', () => setPluginEnabledIpc(id, enabled), ['plugins']),

    createTask: (task) => runActionResult('createTask', () => createTaskIpc(task), ['tasks']),

    updateTask: (id, patch) => runActionResult('updateTask', () => updateTaskIpc(id, patch), ['tasks']),

    deleteTask: (id) => runAction('deleteTask', () => deleteTaskIpc(id), ['tasks']),

    doctorFixSubagentPins: async () => {
      begin('doctorFixSubagentPins');
      let checks: DoctorCheck[];
      try {
        checks = await fixSubagentPins();
      } catch (cause) {
        finish('doctorFixSubagentPins', errorText(cause));
        throw cause;
      }
      finish('doctorFixSubagentPins', null);
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
