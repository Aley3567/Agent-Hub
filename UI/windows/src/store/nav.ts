/**
 * 导航 store。形状取自 CONTRACT.md 第 6.2 节，字段不得增删——四个视图代理直接消费它。
 *
 * 主题是三态：system / dark / light。system 时不写 data-theme 属性，交给
 * tokens.css 里的 prefers-color-scheme 分支接管（DESIGN.md 第 2.2 节）。
 * 偏好持久化在 localStorage，启动时由 main.tsx 先读一遍再挂载，避免首帧闪主题。
 */
import { create } from 'zustand';
import type { VIEWS } from '../shell/views';

export type ViewId = keyof typeof VIEWS;

export interface NavState {
  view: ViewId;
  setView(v: ViewId): void;
  sidebarCollapsed: boolean;
  toggleSidebar(): void;
  paletteOpen: boolean;
  setPaletteOpen(o: boolean): void;
  theme: 'system' | 'dark' | 'light';
  setTheme(t: NavState['theme']): void;
}

export type ThemeMode = NavState['theme'];

/** 主题偏好的 localStorage 键。改名会让老用户回到 system，不要随手改 */
export const THEME_STORAGE_KEY = 'claude1.desktop.theme';

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色',
};

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'dark' || value === 'light';
}

/** 读取持久化的主题偏好；读不到或值不合法都回落到 system */
export function readStoredTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    // 隐私模式或存储被禁用时 localStorage 会抛错，这不该拖垮启动
    return 'system';
  }
}

function writeStoredTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 写不进去就只在本次会话生效，不打断用户操作
  }
}

/** 把主题落到 documentElement：system 态不写属性 */
export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    return;
  }
  root.dataset.theme = theme;
}

/** 三态循环顺序：跟随系统 → 深色 → 浅色 → 跟随系统 */
export function nextTheme(theme: ThemeMode): ThemeMode {
  if (theme === 'system') return 'dark';
  if (theme === 'dark') return 'light';
  return 'system';
}

export const useNav = create<NavState>()((set, get) => ({
  view: 'channels',
  setView: (v) => set({ view: v }),
  sidebarCollapsed: false,
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  paletteOpen: false,
  setPaletteOpen: (o) => set({ paletteOpen: o }),
  theme: readStoredTheme(),
  setTheme: (t) => {
    writeStoredTheme(t);
    applyTheme(t);
    set({ theme: t });
  },
}));
