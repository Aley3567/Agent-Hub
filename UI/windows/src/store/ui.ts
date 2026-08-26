/**
 * 界面外观偏好 store（与 CONTRACT.md 无关的纯本地偏好，不放 nav store——
 * nav store 的形状是 CONTRACT.md 第 6.2 节的契约，字段不得增删）。
 *
 * 目前只有「界面大小」三档：标准 / 大 / 特大。落地方式是给 documentElement 写
 * data-density，global.css 里对应三档 body zoom。偏好持久化在 localStorage，
 * 启动时由 main.tsx 先读一遍再挂载，避免首帧闪尺寸（与主题同一套路）。
 */
import { create } from 'zustand';

export type Density = 'standard' | 'large' | 'larger';

export const DENSITY_LABEL: Record<Density, string> = {
  standard: '标准',
  large: '大',
  larger: '特大',
};

/** 界面大小的 localStorage 键。改名会让老用户回到标准档，不要随手改 */
export const DENSITY_STORAGE_KEY = 'claude1.desktop.density';

function isDensity(value: string | null): value is Density {
  return value === 'standard' || value === 'large' || value === 'larger';
}

/** 读取持久化的界面大小；读不到或值不合法都回落到标准档 */
export function readStoredDensity(): Density {
  try {
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    return isDensity(stored) ? stored : 'standard';
  } catch {
    // 隐私模式或存储被禁用时 localStorage 会抛错，这不该拖垮启动
    return 'standard';
  }
}

function writeStoredDensity(density: Density): void {
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // 写不进去就只在本次会话生效，不打断用户操作
  }
}

/** 把界面大小落到 documentElement：标准档不写属性 */
export function applyDensity(density: Density): void {
  const root = document.documentElement;
  if (density === 'standard') {
    root.removeAttribute('data-density');
    return;
  }
  root.dataset.density = density;
}

interface UiState {
  density: Density;
  setDensity(d: Density): void;
}

export const useUi = create<UiState>()((set) => ({
  density: readStoredDensity(),
  setDensity: (d) => {
    writeStoredDensity(d);
    applyDensity(d);
    set({ density: d });
  },
}));
