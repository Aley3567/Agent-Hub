import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Toolbar.module.css';

export interface ToolbarProps {
  /** 左侧一组控件 */
  children?: ReactNode;
  /** 右侧一组控件（刷新、导出这类） */
  right?: ReactNode;
  /** 底部 1px 分隔线 */
  divider?: boolean;
  /** 在滚动容器里吸顶 */
  sticky?: boolean;
  /** 控件多时允许换行 */
  wrap?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** 视图顶部的控件条：左侧过滤与筛选，右侧动作 */
export function Toolbar({
  children,
  right,
  divider = false,
  sticky = false,
  wrap = true,
  className,
  'aria-label': ariaLabel,
}: ToolbarProps) {
  return (
    <div
      className={cx(styles.root, divider && styles.divider, sticky && styles.sticky, wrap && styles.wrap, className)}
      aria-label={ariaLabel}
    >
      <div className={cx(styles.group, wrap && styles.wrap)}>{children}</div>
      {right === undefined ? null : <div className={styles.group}>{right}</div>}
    </div>
  );
}
