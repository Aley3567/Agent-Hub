import type { ReactNode, SVGProps } from 'react';
import { cx } from '../lib';
import styles from './Icon.module.css';

/**
 * 图标集：线性风格，stroke-width 1.5，viewBox 0 0 24 24，颜色取 currentColor。
 * 名字清单与 CONTRACT.md 第 6.4 节逐字一致，视图只能用这些名字。
 */
export type IconName =
  // 导航
  | 'channels' | 'slots' | 'usage' | 'diagnostics' | 'accounts' | 'doctor' | 'settings'
  // 动作
  | 'search' | 'plus' | 'close' | 'check' | 'refresh' | 'play' | 'copy' | 'edit'
  | 'trash' | 'external' | 'filter' | 'download' | 'reveal'
  // 状态与语义
  | 'warning' | 'error' | 'info' | 'success' | 'dot' | 'clock' | 'zap' | 'lock'
  | 'star' | 'eye' | 'eye-off' | 'pin'
  // 结构
  | 'chevron-right' | 'chevron-down' | 'chevron-left' | 'chevron-up'
  | 'sidebar' | 'terminal' | 'database' | 'network' | 'link' | 'brain' | 'coins'
  // 主题
  | 'moon' | 'sun' | 'monitor'
  // Windows 自绘窗口按钮（仅 windows 工程使用，macOS 侧也实现以保持两侧文件一致）
  | 'win-minimize' | 'win-maximize' | 'win-restore' | 'win-close';

/**
 * 齿轮轮廓按齿数算出来，而不是手抄一串坐标：这样齿距均匀，改齿数也不用重画。
 * 齿顶落在 outer 半径，齿谷落在 inner 半径，每齿占 1/teeth 圈。
 */
function buildGearPath(teeth: number, outer: number, inner: number, cxp: number, cyp: number): string {
  const step = (Math.PI * 2) / teeth;
  const parts: string[] = [];
  for (let i = 0; i < teeth; i += 1) {
    const base = i * step;
    const samples: Array<[number, number]> = [
      [base - step * 0.22, outer],
      [base + step * 0.22, outer],
      [base + step * 0.3, inner],
      [base + step * 0.7, inner],
    ];
    for (const [angle, radius] of samples) {
      const x = cxp + Math.cos(angle) * radius;
      const y = cyp + Math.sin(angle) * radius;
      parts.push(`${parts.length === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  }
  return `${parts.join(' ')} Z`;
}

const GEAR = buildGearPath(8, 9.6, 7.4, 12, 12);

/** 每个名字一套自己的几何，不复用同一个图形糊弄多个名字 */
const GLYPHS: Record<IconName, ReactNode> = {
  // —— 导航 ——
  channels: (
    <>
      <path d="M3.5 6h9" />
      <circle cx="15" cy="6" r="2.1" />
      <path d="M17.1 6h3.4" />
      <path d="M3.5 12h4" />
      <circle cx="9.6" cy="12" r="2.1" />
      <path d="M11.7 12h8.8" />
      <path d="M3.5 18h10.4" />
      <circle cx="16" cy="18" r="2.1" />
      <path d="M18.1 18h2.4" />
    </>
  ),
  slots: (
    <>
      <rect x="3.8" y="3.8" width="7.4" height="7.4" rx="1.6" />
      <rect x="12.8" y="3.8" width="7.4" height="7.4" rx="1.6" />
      <rect x="3.8" y="12.8" width="7.4" height="7.4" rx="1.6" />
      <rect x="12.8" y="12.8" width="7.4" height="7.4" rx="1.6" />
    </>
  ),
  usage: (
    <>
      <path d="M3.5 20.2h17" />
      <rect x="5.6" y="12.4" width="3.6" height="6.4" rx="1" />
      <rect x="10.2" y="8.6" width="3.6" height="10.2" rx="1" />
      <rect x="14.8" y="4.8" width="3.6" height="14" rx="1" />
    </>
  ),
  diagnostics: (
    <>
      <path d="M2.8 12h3.6l2.4-6.2 3.6 12.4 2.4-6.2h5.4" />
    </>
  ),
  accounts: (
    <>
      <circle cx="9.2" cy="8.2" r="3.2" />
      <path d="M3.4 19.6c0-3.1 2.6-5.2 5.8-5.2s5.8 2.1 5.8 5.2" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.4 14.9c1.9.9 3.2 2.6 3.2 4.7" />
    </>
  ),
  doctor: (
    <>
      <path d="M9.2 4.8H7.6A1.6 1.6 0 0 0 6 6.4v12.8a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6V6.4a1.6 1.6 0 0 0-1.6-1.6h-1.6" />
      <rect x="9.2" y="3" width="5.6" height="3.4" rx="1.2" />
      <path d="M9.4 13.4l2.2 2.2 3.6-4.4" />
    </>
  ),
  settings: (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="3.1" />
    </>
  ),

  // —— 动作 ——
  search: (
    <>
      <circle cx="10.6" cy="10.6" r="6.4" />
      <path d="M15.4 15.4l5 5" />
    </>
  ),
  plus: (
    <>
      <path d="M12 4.8v14.4" />
      <path d="M4.8 12h14.4" />
    </>
  ),
  close: (
    <>
      <path d="M6.6 6.6l10.8 10.8" />
      <path d="M17.4 6.6L6.6 17.4" />
    </>
  ),
  check: (
    <>
      <path d="M4.6 12.6l4.9 4.9L19.4 6.6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.4 12a8.4 8.4 0 1 1-3.1-6.5" />
      <path d="M20.4 4.4V9.2h-4.8" />
    </>
  ),
  play: (
    <>
      <path d="M8.6 5.4l9.8 6.6-9.8 6.6z" />
    </>
  ),
  copy: (
    <>
      <rect x="8.8" y="8.8" width="11.4" height="11.4" rx="2" />
      <path d="M15.4 4.2H5.8A1.8 1.8 0 0 0 4 6v9.6" />
    </>
  ),
  edit: (
    <>
      <path d="M4.4 19.6l1.1-4.3L15.7 5.1a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7L8.7 18.5z" />
      <path d="M14.4 6.4l3.6 3.6" />
    </>
  ),
  trash: (
    <>
      <path d="M4.4 7.2h15.2" />
      <path d="M9.6 7.2V5.6A1.6 1.6 0 0 1 11.2 4h1.6a1.6 1.6 0 0 1 1.6 1.6v1.6" />
      <path d="M6.4 7.2l.9 11.5A1.6 1.6 0 0 0 8.9 20.2h6.2a1.6 1.6 0 0 0 1.6-1.5l.9-11.5" />
      <path d="M10.4 10.8v5.8" />
      <path d="M13.6 10.8v5.8" />
    </>
  ),
  external: (
    <>
      <path d="M14.2 4.4h5.4v5.4" />
      <path d="M19.6 4.4L11 13" />
      <path d="M17.8 14.4v3.4a1.8 1.8 0 0 1-1.8 1.8H6.2a1.8 1.8 0 0 1-1.8-1.8V8a1.8 1.8 0 0 1 1.8-1.8h3.4" />
    </>
  ),
  filter: (
    <>
      <path d="M4 5.4h16l-6.3 7.3v5.6l-3.4 1.8v-7.4z" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.2v10.6" />
      <path d="M7.8 11l4.2 4.2 4.2-4.2" />
      <path d="M4.6 19.6h14.8" />
    </>
  ),
  reveal: (
    <>
      <path d="M20.4 18a1.6 1.6 0 0 1-1.6 1.6H5.2A1.6 1.6 0 0 1 3.6 18V6.2a1.6 1.6 0 0 1 1.6-1.6h3.9l2.1 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6z" />
      <path d="M9.6 15.4l4.8-4.8" />
      <path d="M11 10.6h3.4V14" />
    </>
  ),

  // —— 状态与语义 ——
  warning: (
    <>
      <path d="M12 4.4l8.4 14.6H3.6z" />
      <path d="M12 9.6v4.6" />
      <path d="M12 17h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M9.2 9.2l5.6 5.6" />
      <path d="M14.8 9.2l-5.6 5.6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11.2v5.4" />
      <path d="M12 7.9h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M8.2 12.3l2.7 2.7 5-5.6" />
    </>
  ),
  dot: (
    <>
      <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.4 2.1" />
    </>
  ),
  zap: (
    <>
      <path d="M13.6 3L5.4 13.6h5L10.4 21l8.2-10.6h-5z" />
    </>
  ),
  lock: (
    <>
      <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2" />
      <path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" />
      <path d="M12 14v2.6" />
    </>
  ),
  star: (
    <>
      <path d="M12 3.8l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 10l5.9-.8z" />
    </>
  ),
  eye: (
    <>
      <path d="M2.6 12S6.3 6.4 12 6.4 21.4 12 21.4 12 17.7 17.6 12 17.6 2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.7 6.9A9.7 9.7 0 0 1 12 6.4c5.7 0 9.4 5.6 9.4 5.6a17.6 17.6 0 0 1-2.8 3.4" />
      <path d="M6.4 8.6A17.6 17.6 0 0 0 2.6 12S6.3 17.6 12 17.6c1 0 1.9-.2 2.7-.4" />
      <path d="M10.1 10.2a2.8 2.8 0 0 0 3.8 3.9" />
    </>
  ),
  pin: (
    <>
      <path d="M9.4 3.6h5.2v4.3l2.8 4.5H6.6l2.8-4.5z" />
      <path d="M12 12.4v8" />
    </>
  ),

  // —— 结构 ——
  'chevron-right': (
    <>
      <path d="M9.6 5.4l6.8 6.6-6.8 6.6" />
    </>
  ),
  'chevron-down': (
    <>
      <path d="M5.4 9.6L12 16.4l6.6-6.8" />
    </>
  ),
  'chevron-left': (
    <>
      <path d="M14.4 5.4L7.6 12l6.8 6.6" />
    </>
  ),
  'chevron-up': (
    <>
      <path d="M5.4 14.4L12 7.6l6.6 6.8" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" />
      <path d="M9.4 4.6v14.8" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2" />
      <path d="M7.4 10.2l2.6 2.4-2.6 2.4" />
      <path d="M12.6 15h4.2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.4" rx="7.4" ry="2.9" />
      <path d="M4.6 6.4v11.2c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9V6.4" />
      <path d="M4.6 12c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5.6" r="2.6" />
      <circle cx="5.6" cy="18.4" r="2.6" />
      <circle cx="18.4" cy="18.4" r="2.6" />
      <path d="M12 8.2v3.6" />
      <path d="M5.6 15.8v-4h12.8v4" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 14.2a3.6 3.6 0 0 1 0-5.1l2.9-2.9a3.6 3.6 0 0 1 5.1 5.1l-1.4 1.4" />
      <path d="M13.8 9.8a3.6 3.6 0 0 1 0 5.1l-2.9 2.9a3.6 3.6 0 0 1-5.1-5.1l1.4-1.4" />
    </>
  ),
  brain: (
    <>
      <path d="M12 6.2v11.6" />
      <path d="M12 6.6A3.3 3.3 0 0 0 6.5 8.9 2.9 2.9 0 0 0 5.4 13a3.4 3.4 0 0 0 1.5 5.1A3.3 3.3 0 0 0 12 17.6" />
      <path d="M12 6.6a3.3 3.3 0 0 1 5.5 2.3A2.9 2.9 0 0 1 18.6 13a3.4 3.4 0 0 1-1.5 5.1A3.3 3.3 0 0 1 12 17.6" />
    </>
  ),
  coins: (
    <>
      <circle cx="9.2" cy="9.2" r="5.4" />
      <circle cx="14.8" cy="14.8" r="5.4" />
      <path d="M9.2 6.8v4.8" />
    </>
  ),

  // —— 主题 ——
  moon: (
    <>
      <path d="M20 14.6A8.6 8.6 0 0 1 9.4 4 8.6 8.6 0 1 0 20 14.6z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.4" />
      <path d="M12 2.6v2.4" />
      <path d="M12 19v2.4" />
      <path d="M2.6 12h2.4" />
      <path d="M19 12h2.4" />
      <path d="M5.6 5.6l1.7 1.7" />
      <path d="M16.7 16.7l1.7 1.7" />
      <path d="M18.4 5.6l-1.7 1.7" />
      <path d="M7.3 16.7l-1.7 1.7" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.6" width="18" height="11.8" rx="2" />
      <path d="M12 16.4v3.4" />
      <path d="M8.6 19.8h6.8" />
    </>
  ),

  // —— Windows 自绘窗口按钮：Fluent 用直角与平头端点，刻意与上面的圆头动作图标不同 ——
  'win-minimize': (
    <>
      <path d="M4 12h16" strokeLinecap="butt" />
    </>
  ),
  'win-maximize': (
    <>
      <path d="M4.75 4.75h14.5v14.5H4.75z" strokeLinecap="butt" strokeLinejoin="miter" />
    </>
  ),
  'win-restore': (
    <>
      <path d="M7.75 7.75V4.75h11.5v11.5h-3" strokeLinecap="butt" strokeLinejoin="miter" />
      <path d="M4.75 7.75h11.5v11.5H4.75z" strokeLinecap="butt" strokeLinejoin="miter" />
    </>
  ),
  'win-close': (
    <>
      <path d="M4.5 4.5l15 15" strokeLinecap="butt" />
      <path d="M19.5 4.5l-15 15" strokeLinecap="butt" />
    </>
  ),
};

export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height' | 'viewBox' | 'children' | 'title'> {
  name: IconName;
  /** 边长，默认 16 */
  size?: number;
  strokeWidth?: number;
  /** 传了 title 图标才进无障碍树；纯装饰图标保持 aria-hidden */
  title?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, title, className, ...rest }: IconProps) {
  return (
    <svg
      className={cx(styles.icon, className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  );
}
