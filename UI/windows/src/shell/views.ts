/**
 * 视图路由表与视图元数据。
 *
 * VIEWS 的七个键与 import 路径由 CONTRACT.md 第 6.1 节写死：目录名与「默认导出无 props 组件」
 * 的形式都不可更改，否则 lazy 加载会找不到视图。
 * 侧栏标签、视图标题、副标题逐字取自 CONTRACT.md 第 6.5 节的文案锚点表，一个字都不改写。
 */
import type { IconName } from '../components';
import type { RefreshKey } from '../store';
import type { ViewId } from '../store/nav';

export const VIEWS = {
  channels: () => import('../views/channels'),
  slots: () => import('../views/slots'),
  usage: () => import('../views/usage'),
  diagnostics: () => import('../views/diagnostics'),
  accounts: () => import('../views/accounts'),
  doctor: () => import('../views/doctor'),
  settings: () => import('../views/settings'),
} as const;

/** 侧栏分组：会话（渠道、槽位）、观测（用量、诊断、账号池、体检）、底部固定的设置 */
export type ViewGroup = 'session' | 'observe' | 'system';

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

/** 侧栏与 Ctrl+1..7 的顺序，也是命令面板导航组的顺序 */
export const VIEW_ORDER = [
  'channels',
  'slots',
  'usage',
  'diagnostics',
  'accounts',
  'doctor',
  'settings',
] as const satisfies readonly ViewId[];

export const VIEW_META: Record<ViewId, ViewMeta> = {
  channels: {
    id: 'channels',
    navLabel: '渠道',
    title: '渠道',
    subtitle: '哪些渠道可用、各自说什么协议、这次用哪个',
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
export const VIEW_LIST: ViewMeta[] = VIEW_ORDER.map((id) => VIEW_META[id]);

export const GROUP_LABEL: Record<ViewGroup, string> = {
  session: '会话',
  observe: '观测',
  system: '系统',
};

/** 侧栏主体渲染的两组；system 组固定在底部，不参与这里的循环 */
export const SIDEBAR_GROUPS: ViewGroup[] = ['session', 'observe'];

/** 每个视图按 Ctrl+R 时该刷新哪个 store key */
export const VIEW_REFRESH_KEY: Record<ViewId, RefreshKey> = {
  channels: 'channels',
  slots: 'hubs',
  usage: 'usage',
  diagnostics: 'errors',
  accounts: 'pools',
  doctor: 'doctor',
  settings: 'env',
};

/** Ctrl+1..7 的展示用序号，Sidebar 与命令面板都拿它做提示（DESIGN.md 第 5 节 Windows 列） */
export function viewShortcut(id: ViewId): string {
  return `Ctrl+${VIEW_ORDER.indexOf(id) + 1}`;
}
