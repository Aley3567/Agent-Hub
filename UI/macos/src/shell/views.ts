/** Shared route metadata. Workspace shortcuts retain their original numeric positions. */
import type { IconName } from '../components';
import { useApp } from '../store';
import type { RefreshKey } from '../store';
import { useNav } from '../store/nav';
import type { ViewId } from '../store/nav';

export const VIEWS = {
  pullRequests: () => import('../views/pull-requests'),
  chat: () => import('../views/chat'),
  channels: () => import('../views/channels'),
  slots: () => import('../views/slots'),
  usage: () => import('../views/usage'),
  diagnostics: () => import('../views/diagnostics'),
  accounts: () => import('../views/accounts'),
  doctor: () => import('../views/doctor'),
  plugins: () => import('../views/plugins'),
  tasks: () => import('../views/tasks'),
  settings: () => import('../views/settings'),
} as const;

/**
 * 侧栏分组（DESIGN.md 第 3 节）：会话（对话、渠道、槽位）、观测（用量、诊断、账号池、体检）、
 * 扩展（插件、任务）。system 组是底部固定的设置，不参与主体循环。
 */
export type ViewGroup = 'work' | 'session' | 'observe' | 'extend' | 'system';

export interface ViewMeta {
  id: ViewId;
  /** 侧栏标签 */
  navLabel: string;
  /** 视图标题 */
  title: string;
  /** 副标题：一句话说清这页在回答什么问题 */
  subtitle: string;
  /** 图标名，取自 CONTRACT.md 第 6.4 节的固定清单 */
  icon: IconName;
  group: ViewGroup;
  /** 表格类视图可满宽；其余居中并受 --content-max-w 约束（DESIGN.md 第 3 节） */
  fullWidth: boolean;
}

/** 侧栏与 Cmd+1..9/0 的顺序，也是命令面板导航组的顺序（即 VIEWS 的键序） */
export const VIEW_ORDER = [
  'chat',
  'channels',
  'slots',
  'usage',
  'diagnostics',
  'accounts',
  'doctor',
  'plugins',
  'tasks',
  'settings',
  'pullRequests',
] as const satisfies readonly ViewId[];

export const VIEW_META: Record<ViewId, ViewMeta> = {
  pullRequests: { id: 'pullRequests', navLabel: 'Pull Request', title: 'Pull Request', subtitle: '查看与你相关的代码审查', icon: 'pull-request', group: 'work', fullWidth: false },
  chat: {
    id: 'chat',
    navLabel: '对话',
    title: '对话',
    subtitle: '和当前渠道直接说上话，验证配置是不是真的能用',
    icon: 'chat',
    group: 'session',
    // 对话视图满宽且自身接管滚动（DESIGN.md 第 4.5 节），是「唯一滚动容器」的唯一视图级例外
    fullWidth: true,
  },
  channels: {
    id: 'channels',
    navLabel: '渠道',
    title: '渠道',
    subtitle: '选择渠道与模型，开始会话',
    icon: 'channels',
    group: 'session',
    fullWidth: true,
  },
  slots: {
    id: 'slots',
    navLabel: '槽位',
    title: '模型槽位',
    subtitle: '四个槽位分别绑到哪个渠道的哪个模型',
    icon: 'slots',
    group: 'session',
    fullWidth: false,
  },
  usage: {
    id: 'usage',
    navLabel: '用量',
    title: '用量与成本',
    subtitle: 'token 花在哪儿、缓存命中多少',
    icon: 'usage',
    group: 'observe',
    fullWidth: false,
  },
  diagnostics: {
    id: 'diagnostics',
    navLabel: '诊断',
    title: '诊断',
    subtitle: '失败了什么、悄悄降级了什么',
    icon: 'diagnostics',
    group: 'observe',
    fullWidth: true,
  },
  accounts: {
    id: 'accounts',
    navLabel: '账号池',
    title: '账号池',
    subtitle: '同一渠道的多个账号怎么轮换',
    icon: 'accounts',
    group: 'observe',
    fullWidth: true,
  },
  doctor: {
    id: 'doctor',
    navLabel: '体检',
    title: '本机体检',
    subtitle: '本机配置有没有问题，只读不联网',
    icon: 'doctor',
    group: 'observe',
    fullWidth: false,
  },
  plugins: {
    id: 'plugins',
    navLabel: '插件',
    title: '插件',
    subtitle: 'hooks、输出风格、状态栏、权限这些扩展点各自是什么状态',
    icon: 'plugins',
    group: 'extend',
    fullWidth: false,
  },
  tasks: {
    id: 'tasks',
    navLabel: '定时任务',
    title: '定时任务',
    subtitle: '应用运行期间自动触发，退出或休眠后不补跑',
    icon: 'tasks',
    group: 'work',
    fullWidth: false,
  },
  settings: {
    id: 'settings',
    navLabel: '设置',
    title: '设置',
    subtitle: '外观、路径与本机环境',
    icon: 'settings',
    group: 'system',
    fullWidth: false,
  },
};

/** 元数据数组，按侧栏顺序 */
export const VIEW_LIST: ViewMeta[] = ['pullRequests' as ViewId, ...VIEW_ORDER.filter(id => id !== 'pullRequests')].map((id) => VIEW_META[id]);

export const GROUP_LABEL: Record<ViewGroup, string> = {
  work: '工作',
  session: '会话',
  observe: '观测',
  extend: '扩展',
  system: '系统',
};

/** 侧栏主体渲染的三组；system 组固定在底部，不参与这里的循环 */
export const SIDEBAR_GROUPS: ViewGroup[] = ['work', 'session', 'observe', 'extend'];

/**
 * 每个视图刷新时该刷哪些 store key。口径与各视图自己的 reload 实现逐一核对过：
 * diagnostics 的降级区同时吃 errors 与 usage 两份流水，slots 的统计行同时吃
 * hubs / channels / usage，所以这两个视图不止一个 key。数组顺序即刷新顺序。
 */
export const VIEW_REFRESH_KEY: Record<ViewId, RefreshKey[]> = {
  pullRequests: [],
  chat: ['chat', 'chatProjects'],
  channels: ['channels'],
  slots: ['hubs', 'channels', 'usage'],
  usage: ['usage'],
  diagnostics: ['errors', 'usage'],
  accounts: ['pools'],
  doctor: ['doctor'],
  plugins: ['plugins'],
  tasks: ['tasks'],
  settings: ['env'],
};

/**
 * 壳层刷新当前视图的唯一入口（⌘R、ViewHeader 刷新按钮、命令面板都走这里）：
 * 视图通过 useNav.registerViewReload 注册了自己的 reload 就整页转发，保持与视图
 * 内 Toolbar 刷新同一口径；没注册就按 VIEW_REFRESH_KEY 逐个刷 store。
 * store key 路径与 store.refresh 一样永不抛出，成败由调用方读 error[key] 判别；
 * 已注册 reload 的视图是否抛出由视图自己的实现决定（现有视图 reload 均走 store.refresh，不抛）。
 */
export async function refreshView(view: ViewId): Promise<void> {
  const reload = useNav.getState().viewReloads[view];
  if (reload) {
    await reload();
    return;
  }
  await Promise.all(VIEW_REFRESH_KEY[view].map((key) => useApp.getState().refresh(key)));
}

/**
 * Cmd+1..9、Cmd+0 的展示用序号，Sidebar 与命令面板都拿它做提示。
 * 十个视图九个数字键不够：第十个（设置）沿用常见惯例落在 ⌘0 上。
 */
export function viewShortcut(id: ViewId): string {
  const index = VIEW_ORDER.indexOf(id);
  if (index >= 10) return '';
  return `⌘${index === 9 ? 0 : index + 1}`;
}
