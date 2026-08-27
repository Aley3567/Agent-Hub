/**
 * IPC 包装层。CONTRACT.md 第 3 节的每个 snake_case 命令在这里对应一个同名 camelCase 函数，
 * 类型全部取自 `../types/contract`。
 *
 * 三条规则决定了这一层的全部行为：
 *
 * 1. **没有 Rust 环境时回退到离线示例数据**（CONTRACT.md 第 4 节）。判定就是契约写死的那一条：
 *    `typeof window.__TAURI_INTERNALS__ === 'undefined'`。回退时 `isOffline` 为 true，
 *    StatusBar 据此亮琥珀色徽章，绝不让假数据冒充真实数据。
 *
 * 2. **Rust 在、但命令失败时，错误原样抛回，不回退**。CONTRACT.md 第 4 节把「IPC 抛错」也
 *    列成了回退触发条件，这里刻意只回退第一种：Rust 明明在，命令报的就是本机真实故障
 *    （数据库读不了、配置写不进去），用示例数据顶上会把故障藏起来——那正是 AGENTS.md
 *    禁止的「伪装成功」，而 CONTRACT.md 第 3 节自己也要求错误原样暴露。两条冲突时按
 *    安全边界取严的那一侧。
 *
 * 3. **离线模式下写操作一律拒绝**。示例数据没有落盘的去处，返回成功就是撒谎。
 *    `launch` 同理：没有真的开终端，就不能给 `ok: true`。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AccountPool,
  AppEnv,
  Channel,
  ChatMessage,
  ChatSession,
  DoctorCheck,
  Effort,
  ErrorRow,
  Granularity,
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
import {
  MOCK_CHANNELS,
  MOCK_CHAT_SESSIONS,
  MOCK_DOCTOR,
  MOCK_ENV,
  MOCK_ERRORS,
  MOCK_HUBS,
  MOCK_PLUGINS,
  MOCK_POOLS,
  MOCK_TASKS,
  MOCK_USAGE,
  mockCreateTask,
  mockDeleteTask,
  mockSendChatMessage,
  mockSetPluginEnabled,
  mockUpdateTask,
  mockUsageSummary,
} from './mock';

declare global {
  interface Window {
    /** Tauri v2 注入的 IPC 内部对象。浏览器里跑前端时它不存在。 */
    __TAURI_INTERNALS__?: unknown;
  }
}

/**
 * 是否处于离线（无 Rust）模式。
 *
 * 模块加载时求值一次：Tauri 的 IPC 桥在文档脚本执行前就注入好了，之后不会中途出现或消失，
 * 所以没有必要每次调用都探一遍。store 直接读这个绑定填 `AppState.offline`。
 */
export const isOffline: boolean = typeof window === 'undefined' || typeof window.__TAURI_INTERNALS__ === 'undefined';

/** 离线模式下拒绝写操作时说的话。把「为什么不行」和「怎么才行」一起说清。 */
function offlineWriteRejection(action: string): Error {
  return new Error(
    `现在显示的是离线示例数据（没有检测到 Rust 侧），${action}没有可以落盘的地方，所以这一步没有执行。请在 Agent Hub 桌面应用里操作，或用命令行改配置。`,
  );
}

/** 读命令：离线时给示例数据，否则直通 IPC，错误原样抛回。 */
async function read<T>(command: string, args: Record<string, unknown>, fallback: () => T): Promise<T> {
  if (isOffline) return fallback();
  return invoke<T>(command, args);
}

/** 写命令：离线时拒绝，否则直通 IPC。 */
async function write(command: string, args: Record<string, unknown>, action: string): Promise<void> {
  if (isOffline) throw offlineWriteRejection(action);
  await invoke<void>(command, args);
}

// ---------------------------------------------------------------------------
// 渠道
// ---------------------------------------------------------------------------

export function listChannels(): Promise<Channel[]> {
  return read('list_channels', {}, () => MOCK_CHANNELS);
}

export function setChannelHidden(id: string, hidden: boolean): Promise<void> {
  return write('set_channel_hidden', { id, hidden }, '改隐藏状态');
}

export function setChannelAlias(id: string, alias: string | null): Promise<void> {
  return write('set_channel_alias', { id, alias }, '改别名');
}

export function setChannelOverride(id: string, model: string | null, effort: Effort | null): Promise<void> {
  return write('set_channel_override', { id, model, effort }, '改本地覆盖');
}

// ---------------------------------------------------------------------------
// hub 与槽位
// ---------------------------------------------------------------------------

export function listHubs(): Promise<HubConfig[]> {
  return read('list_hubs', {}, () => MOCK_HUBS);
}

export function setHubSlot(
  hubName: string,
  slot: SlotName,
  channel: string | null,
  model: string | null,
): Promise<void> {
  return write('set_hub_slot', { hubName, slot, channel, model }, '改槽位绑定');
}

export function setHubSlotEffort(hubName: string, slot: SlotName, effort: Effort | null): Promise<void> {
  return write('set_hub_slot_effort', { hubName, slot, effort }, '改槽位 effort');
}

// ---------------------------------------------------------------------------
// 流水
// ---------------------------------------------------------------------------

export function usageSummary(
  fromTs: number,
  toTs: number,
  granularity: Granularity,
  hubName?: string | null,
): Promise<UsageSummary> {
  return read(
    'usage_summary',
    { hubName: hubName ?? null, fromTs, toTs, granularity },
    () => mockUsageSummary(fromTs, toTs, granularity),
  );
}

export function recentUsage(limit: number, hubName?: string | null): Promise<UsageRow[]> {
  return read('recent_usage', { limit, hubName: hubName ?? null }, () => {
    const name = hubName ?? null;
    const rows = name === null ? MOCK_USAGE : MOCK_USAGE.filter((row) => row.hub === name);
    // 契约要求倒序最近 N 行；示例数据按时间升序存着，这里不改原数组
    return rows.slice(-limit).reverse();
  });
}

export function recentErrors(limit: number): Promise<ErrorRow[]> {
  // MOCK_ERRORS 已按时间倒序
  return read('recent_errors', { limit }, () => MOCK_ERRORS.slice(0, limit));
}

// ---------------------------------------------------------------------------
// 账号池与体检
// ---------------------------------------------------------------------------

export function listAccountPools(): Promise<AccountPool[]> {
  return read('list_account_pools', {}, () => MOCK_POOLS);
}

export function runDoctor(): Promise<DoctorCheck[]> {
  return read('run_doctor', {}, () => MOCK_DOCTOR);
}

export function doctorFixSubagentPins(): Promise<DoctorCheck[]> {
  if (isOffline) return Promise.reject(offlineWriteRejection('清理子代理模型固定值'));
  return invoke<DoctorCheck[]>('doctor_fix_subagent_pins', {});
}

// ---------------------------------------------------------------------------
// 启动、环境与打开路径
// ---------------------------------------------------------------------------

export function launch(target: LaunchTarget): Promise<LaunchResult> {
  if (isOffline) return Promise.reject(offlineWriteRejection('启动会话'));
  return invoke<LaunchResult>('launch', { target });
}

export function appEnv(): Promise<AppEnv> {
  return read('app_env', {}, () => MOCK_ENV);
}

export function openPath(path: string): Promise<void> {
  return write('open_path', { path }, '打开路径');
}

export function revealInFolder(path: string): Promise<void> {
  return write('reveal_in_folder', { path }, '在 Finder 中显示');
}

// ---------------------------------------------------------------------------
// 对话、插件与计划任务
// ---------------------------------------------------------------------------
//
// 这一组与上面「离线拒绝写」的纪律不同：对话本轮恒为演示实现（Rust 侧也不连上游），
// 任务与插件的开关是本轮新 surface——CONTRACT.md 第 4 节要求 mock 覆盖它们，
// 所以离线模式下 mock 层就地改示例数据并回新值，让视图调试时能看到状态流转。
// 「离线示例数据」徽章照亮，假数据不会冒充真实数据。

export function listChatSessions(): Promise<ChatSession[]> {
  return read('list_chat_sessions', {}, () => [...MOCK_CHAT_SESSIONS]);
}

export function sendChatMessage(sessionId: string, content: string): Promise<ChatMessage> {
  if (isOffline) return mockSendChatMessage(sessionId, content);
  return invoke<ChatMessage>('send_chat_message', { sessionId, content });
}

export function listPlugins(): Promise<PluginItem[]> {
  return read('list_plugins', {}, () => MOCK_PLUGINS);
}

export function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  if (isOffline) return mockSetPluginEnabled(id, enabled);
  return invoke<void>('set_plugin_enabled', { id, enabled });
}

export function listTasks(): Promise<ScheduledTask[]> {
  // 离线回退必须返回浅拷贝：mock 的增删改就地在 MOCK_TASKS 上做，同一数组引用
  // 会让 zustand 的引用相等判定跳过重渲染——建/删任务 toast 报成功但界面不动
  return read('list_tasks', {}, () => [...MOCK_TASKS]);
}

export function createTask(task: NewScheduledTask): Promise<ScheduledTask> {
  if (isOffline) return mockCreateTask(task);
  return invoke<ScheduledTask>('create_task', { task });
}

export function updateTask(
  id: string,
  patch: { enabled?: boolean; schedule?: string; name?: string },
): Promise<ScheduledTask> {
  if (isOffline) return mockUpdateTask(id, patch);
  return invoke<ScheduledTask>('update_task', { id, patch });
}

export function deleteTask(id: string): Promise<void> {
  if (isOffline) return mockDeleteTask(id);
  return invoke<void>('delete_task', { id });
}
