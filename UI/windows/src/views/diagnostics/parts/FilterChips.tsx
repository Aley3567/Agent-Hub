/**
 * 分档汇总条：一排「圆点 + 中文档位名 + 计数」的筹码，点一下只看这一档，再点一下取消。
 * 降级区按严重度用它，失败区按失败类型用它——两处口径不同但交互一致，所以做成一个组件。
 *
 * 计数与筛选必须同口径（见各调用方的 caption），否则数字和列表长度对不上，界面就在骗人。
 */
import type { ReactNode } from 'react';
import { StatusDot } from '../../../components';
import type { StatusToneInput } from '../../../components';
import { cx, formatCount } from '../../../lib';
import styles from './FilterChips.module.css';

export interface FilterChip<T extends string> {
  id: T;
  label: string;
  count: number;
  tone: StatusToneInput;
  title?: string;
}

export interface FilterChipsProps<T extends string> {
  chips: ReadonlyArray<FilterChip<T>>;
  /** 当前选中的档，null 表示不筛选 */
  active: T | null;
  onChange: (id: T | null) => void;
  allLabel: string;
  allCount: number;
  /** 一句话说清这排数字是什么口径 */
  caption?: ReactNode;
  'aria-label': string;
}

export function FilterChips<T extends string>({
  chips,
  active,
  onChange,
  allLabel,
  allCount,
  caption,
  'aria-label': ariaLabel,
}: FilterChipsProps<T>) {
  return (
    <div className={styles.root}>
      <div className={styles.row} role="group" aria-label={ariaLabel}>
        <button
          type="button"
          className={cx(styles.chip, active === null && styles.active)}
          aria-pressed={active === null}
          onClick={() => onChange(null)}
        >
          <span className={styles.label}>{allLabel}</span>
          <span className={styles.count}>{formatCount(allCount)}</span>
        </button>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={cx(styles.chip, active === chip.id && styles.active)}
            aria-pressed={active === chip.id}
            title={chip.title}
            onClick={() => onChange(active === chip.id ? null : chip.id)}
          >
            <StatusDot tone={chip.tone}>{chip.label}</StatusDot>
            <span className={styles.count}>{formatCount(chip.count)}</span>
          </button>
        ))}
      </div>
      {caption === undefined ? null : <p className={styles.caption}>{caption}</p>}
    </div>
  );
}
