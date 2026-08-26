import type { CSSProperties } from 'react';
import { cx } from '../lib';
import styles from './Spinner.module.css';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  /**
   * 预设档位或直接给边长像素。**不传是默认路径**，与 Icon 同走 tokens.css 的
   * --icon-size（20px）栅格，这样 Button 在 loading 前后不会横向抖动。
   */
  size?: SpinnerSize | number;
  /** 有文字时并排显示，同时作为无障碍名 */
  label?: string;
  className?: string;
}

const PRESET: Record<SpinnerSize, number> = { sm: 14, md: 18, lg: 24 };

/** 行内加载指示。页面级加载态用顶部 1px 进度线，这里只服务行内场景（DESIGN.md 第 2.5 节） */
export function Spinner({ size, label, className }: SpinnerProps) {
  const edge = size === undefined ? undefined : typeof size === 'number' ? size : PRESET[size];
  return (
    <span className={cx(styles.wrap, className)} role="status" aria-live="polite">
      <svg
        className={styles.svg}
        style={edge === undefined ? undefined : ({ '--spinner-box': `${edge}px` } as CSSProperties)}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        {/* 线宽走 CSS 的 --stroke-w，两条弧共用一套线宽，见 Spinner.module.css */}
        <circle cx="12" cy="12" r="9" stroke="var(--border-default)" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--accent)" strokeLinecap="round" />
      </svg>
      <span className={label ? styles.label : styles.srOnly}>{label ?? '加载中'}</span>
    </span>
  );
}
