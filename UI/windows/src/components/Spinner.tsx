import { cx } from '../lib';
import styles from './Spinner.module.css';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  /** 预设档位或直接给边长像素 */
  size?: SpinnerSize | number;
  /** 有文字时并排显示，同时作为无障碍名 */
  label?: string;
  className?: string;
}

const PRESET: Record<SpinnerSize, number> = { sm: 14, md: 18, lg: 24 };

/** 行内加载指示。页面级加载态用顶部 1px 进度线，这里只服务行内场景（DESIGN.md 第 2.5 节） */
export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  const edge = typeof size === 'number' ? size : PRESET[size];
  return (
    <span className={cx(styles.wrap, className)} role="status" aria-live="polite">
      <svg
        className={styles.svg}
        width={edge}
        height={edge}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" stroke="var(--border-default)" strokeWidth="2.4" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      <span className={label ? styles.label : styles.srOnly}>{label ?? '加载中'}</span>
    </span>
  );
}
