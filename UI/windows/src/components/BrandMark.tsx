import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './BrandMark.module.css';

export interface BrandMarkProps {
  /** 折叠态只显示图形；展开态同时显示字标 */
  collapsed?: boolean;
  /** 大号用于空态 hero */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Agent Hub：四向入口围绕共享中心，单色标识随主题适配。 */
export function BrandMark({ collapsed = false, size = 'sm', className }: BrandMarkProps): ReactNode {
  const markSize = size === 'lg' ? 48 : size === 'md' ? 36 : 32;
  return (
    <div className={cx(styles.root, styles[size], collapsed && styles.collapsed, className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 256 256"
        role="img"
        aria-label="Agent Hub"
        width={markSize}
        height={markSize}
      >
        <g fill="none" stroke="currentColor" strokeWidth="28" strokeLinecap="round">
          <path d="M104 48H76C60.536 48 48 60.536 48 76V104" />
          <path d="M152 48H180C195.464 48 208 60.536 208 76V104" />
          <path d="M208 152V180C208 195.464 195.464 208 180 208H152" />
          <path d="M104 208H76C60.536 208 48 195.464 48 180V152" />
        </g>
        <rect x="104" y="104" width="48" height="48" rx="14" fill="currentColor" />
      </svg>
      {collapsed ? null : <span className={styles.wordmark}>Agent Hub</span>}
    </div>
  );
}
