import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Card.module.css';

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** 头部右侧动作区 */
  actions?: ReactNode;
  /** 完全自定义头部；给了它就不再渲染 title / subtitle / actions */
  header?: ReactNode;
  footer?: ReactNode;
  /** 内容区去掉内边距，让表格贴边 */
  flush?: boolean;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  'aria-label'?: string;
}

/** 卡片靠背景层次而不是重边框区分（DESIGN.md 第 1 节的 Cursor 坐标） */
export function Card({
  title,
  subtitle,
  actions,
  header,
  footer,
  flush = false,
  children,
  className,
  bodyClassName,
  id,
  'aria-label': ariaLabel,
}: CardProps) {
  const hasDefaultHeader =
    header === undefined &&
    (title !== undefined || subtitle !== undefined || actions !== undefined);
  return (
    <section className={cx(styles.card, className)} id={id} aria-label={ariaLabel}>
      {header !== undefined ? <div className={styles.header}>{header}</div> : null}
      {hasDefaultHeader ? (
        <div className={styles.header}>
          <div className={styles.heading}>
            {title !== undefined ? <div className={styles.title}>{title}</div> : null}
            {subtitle !== undefined ? <div className={styles.subtitle}>{subtitle}</div> : null}
          </div>
          {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      <div className={cx(flush ? styles.bodyFlush : styles.body, bodyClassName)}>{children}</div>
      {footer !== undefined ? <div className={styles.footer}>{footer}</div> : null}
    </section>
  );
}
