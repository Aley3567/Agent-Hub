import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'violet' | 'success' | 'warn' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  /** 关掉等宽（默认开启，因为徽章多半装的是协议名、降级码这类技术标识） */
  mono?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

/** 高 18、--fs-11、mono、*-muted 底加对应语义文字色（DESIGN.md 第 4.1 节） */
export function Badge({ tone = 'neutral', mono = true, title, className, children }: BadgeProps) {
  return (
    <span className={cx(styles.badge, styles[tone], mono && styles.mono, className)} title={title}>
      {children}
    </span>
  );
}
