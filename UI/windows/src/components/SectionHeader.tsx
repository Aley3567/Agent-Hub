import type { ReactNode } from 'react';
import { cx } from '../lib';
import { formatCount } from '../lib';
import styles from './SectionHeader.module.css';

export interface SectionHeaderProps {
  title: ReactNode;
  /** 一句话说清这一段在回答什么问题 */
  subtitle?: ReactNode;
  /** subtitle 的别名 */
  description?: ReactNode;
  /** 条目数，显示在标题右侧，等宽 */
  count?: number | null;
  /** 右侧动作区 */
  actions?: ReactNode;
  /** 2 渲染 h2（视图内的一级分区），3 渲染 h3 */
  level?: 2 | 3;
  id?: string;
  className?: string;
}

export function SectionHeader({
  title,
  subtitle,
  description,
  count,
  actions,
  level = 2,
  id,
  className,
}: SectionHeaderProps) {
  const caption = subtitle ?? description;
  const heading = (
    <span className={styles.titleText}>
      {title}
      {count === null || count === undefined ? null : <span className={styles.count}>{formatCount(count)}</span>}
    </span>
  );
  return (
    <div className={cx(styles.root, className)}>
      <div className={styles.headingBlock}>
        {level === 2 ? (
          <h2 className={styles.h2} id={id}>
            {heading}
          </h2>
        ) : (
          <h3 className={styles.h3} id={id}>
            {heading}
          </h3>
        )}
        {caption === undefined ? null : <p className={styles.caption}>{caption}</p>}
      </div>
      {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
