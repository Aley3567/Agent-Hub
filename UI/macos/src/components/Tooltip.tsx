import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Tooltip.module.css';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** 提示文字 */
  content?: ReactNode;
  /** content 的别名，两者取其一即可 */
  label?: ReactNode;
  side?: TooltipSide;
  children: ReactNode;
  className?: string;
  /** 关掉提示（例如侧栏展开态文字已可见，不需要再浮一层） */
  disabled?: boolean;
}

/**
 * 纯 CSS 悬浮提示：延迟 400ms 出现、离开立刻消失（DESIGN.md 第 4.1 节）。
 * 不引任何依赖，也不做 portal——它只贴在触发元素旁边。
 */
export function Tooltip({ content, label, side = 'top', children, className, disabled = false }: TooltipProps) {
  const text = content ?? label;
  if (disabled || text === null || text === undefined || text === '') {
    return <>{children}</>;
  }
  return (
    <span className={cx(styles.wrap, className)}>
      {children}
      <span role="tooltip" className={cx(styles.bubble, styles[side])}>
        {text}
      </span>
    </span>
  );
}
