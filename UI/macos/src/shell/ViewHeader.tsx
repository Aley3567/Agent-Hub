/**
 * 视图头部：标题、计数、右侧动作区插槽。
 * 标题与副标题一律从 views.ts 的元数据取（CONTRACT.md 第 6.5 节的文案锚点），
 * 调用方只需给出视图 id，避免同一句话在多处各写一遍然后慢慢走形。
 */
import type { ReactNode } from 'react';
import type { ViewId } from '../store/nav';
import { VIEW_META } from './views';
import styles from './ViewHeader.module.css';

export interface ViewHeaderProps {
  view: ViewId;
  /** 计数摘要，例如「8 个渠道」。没有可数的东西时传 null */
  count?: string | null;
  /** 右侧动作区 */
  actions?: ReactNode;
}

export default function ViewHeader({ view, count = null, actions }: ViewHeaderProps) {
  const meta = VIEW_META[view];

  return (
    <header className={styles.header}>
      <div className={styles.text}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{meta.title}</h1>
          {count === null ? null : <span className={styles.count}>{count}</span>}
        </div>
        <p className={styles.subtitle}>{meta.subtitle}</p>
      </div>
      {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
