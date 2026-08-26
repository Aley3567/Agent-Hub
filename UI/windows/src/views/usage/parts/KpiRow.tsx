/**
 * 用量页 KPI 区：左侧英雄大数字 + 右侧两小卡 + 下方五格汇总条。
 *
 * 汇总条第五格是缓存命中率进度条，其余四格是 token 口径。
 * 所有数字 mono + tabular-nums，颜色只表达语义（成本命中用 --success）。
 */
import { cx } from '../../../lib';
import styles from './KpiRow.module.css';

export interface KpiItem {
  /** 指标名 */
  label: string;
  /** 已格式化好的值，等宽显示 */
  value: string;
  /** 口径说明，一句话 */
  caption: string;
  /** 英雄数字下方的副行，如「≈ 1.20 亿」 */
  subValue?: string;
  /** 0–1 的进度，用于缓存命中率 */
  progress?: number;
  /** 是否用 --success 色突出（有成本时） */
  accent?: boolean;
}

export interface KpiRowProps {
  hero: KpiItem;
  side: readonly [KpiItem, KpiItem];
  bars: readonly KpiItem[];
  'aria-label'?: string;
  className?: string;
}

export function KpiRow({
  hero,
  side,
  bars,
  'aria-label': ariaLabel,
  className,
}: KpiRowProps) {
  return (
    <div className={cx(styles.root, className)} aria-label={ariaLabel}>
      <div className={styles.heroSection}>
        <div className={styles.heroCard}>
          <span className={styles.heroLabel}>{hero.label}</span>
          <span className={styles.heroValue}>{hero.value}</span>
          {hero.subValue ? <span className={styles.heroSub}>{hero.subValue}</span> : null}
          <span className={styles.heroCaption}>{hero.caption}</span>
        </div>
        <div className={styles.sideCards}>
          {side.map((item) => (
            <div key={item.label} className={styles.sideCard}>
              <span className={styles.sideLabel}>{item.label}</span>
              <span
                className={cx(
                  styles.sideValue,
                  item.accent === true && styles.sideValueSuccess,
                )}
              >
                {item.value}
              </span>
              <span className={styles.sideCaption}>{item.caption}</span>
            </div>
          ))}
        </div>
      </div>

      <ul className={styles.barRow} aria-label="用量汇总">
        {bars.map((item) => (
          <li key={item.label} className={styles.barCell}>
            <span className={styles.barLabel}>{item.label}</span>
            <span className={styles.barValue}>{item.value}</span>
            {item.progress !== undefined ? (
              <span className={styles.barProgressTrack} aria-hidden="true">
                <span
                  className={styles.barProgressFill}
                  style={{
                    width: `${Math.max(0, Math.min(1, item.progress)) * 100}%`,
                  }}
                />
              </span>
            ) : null}
            <span className={styles.barCaption}>{item.caption}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
