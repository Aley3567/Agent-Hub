/**
 * 诊断长页的右侧锚点导航（REDESIGN-PROMPT 1.5 / 2.3-1）。
 *
 * 连续长页失去方位的解法是「可跳转 + 知道自己在哪里」：点锚点滚到对应小节，
 * 滚动时由调用方的 scroll-spy 回传当前小节，当前项用 aria-current 标出。
 * 本组件只负责摆放与五态，滚动与判定都在视图里。
 */
import { cx, formatCount } from '../../../lib';
import styles from './SectionNav.module.css';

export interface SectionNavItem<T extends string> {
  id: T;
  label: string;
  /** 该小节的条目数，等宽右对齐 */
  count: number;
}

export interface SectionNavProps<T extends string> {
  items: ReadonlyArray<SectionNavItem<T>>;
  /** 当前小节（scroll-spy 或点击后的值） */
  active: T;
  onJump: (id: T) => void;
  'aria-label': string;
  className?: string;
}

export function SectionNav<T extends string>({
  items,
  active,
  onJump,
  'aria-label': ariaLabel,
  className,
}: SectionNavProps<T>) {
  return (
    <nav className={className} aria-label={ariaLabel}>
      <span className={styles.label}>小节</span>
      <ul className={styles.list}>
        {items.map((item) => {
          const current = item.id === active;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={cx(styles.anchor, current && styles.current)}
                aria-current={current ? 'location' : undefined}
                onClick={() => onJump(item.id)}
              >
                <span className={styles.anchorText}>{item.label}</span>
                <span className={styles.count}>{formatCount(item.count)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
