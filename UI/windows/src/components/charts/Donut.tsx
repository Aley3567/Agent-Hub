import type { ReactNode } from 'react';
import { cx, formatPercent } from '../../lib';
import styles from './Donut.module.css';

export interface DonutProps {
  /** 0–1 的比率（UsageSummary.cacheHitRate 就是这个口径）。null 表示算不出来，绝不当 0 处理 */
  value: number | null | undefined;
  /** 环下方的说明，例如「缓存命中率」 */
  label?: ReactNode;
  /** 再补一行细节，例如「缓存读 / 总输入」 */
  caption?: ReactNode;
  /** 外径，默认 120 */
  size?: number;
  /** 环色，默认 var(--accent) */
  color?: string;
  /** 值为 null 时的一句中文说明 */
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
}

/** DESIGN.md 第 4.2 节：环宽 8，中心百分比 --fs-20 */
const RING = 8;

/**
 * 单指标环形图。这里刻意不用 preserveAspectRatio="none"：圆被拉扁就不是环了，
 * 所以按正方形固定尺寸渲染，自适应交给调用方的栅格。
 */
export function Donut({
  value,
  label,
  caption,
  size = 120,
  color = 'var(--accent)',
  emptyText = '没有输入 token，算不出命中率',
  ariaLabel,
  className,
}: DonutProps) {
  const radius = (size - RING) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const known = raw !== null;
  // 容忍调用方传 0–100 的百分数：大于 1 一律按百分数解释
  const ratio = raw === null ? 0 : Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
  const text = known ? formatPercent(ratio) : '—';
  const footNote = known ? caption : emptyText;

  return (
    <div className={cx(styles.root, className)}>
      <svg
        className={styles.svg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel ?? (known ? `占比 ${text}` : emptyText)}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border-subtle)"
          strokeWidth={RING}
          strokeDasharray={known ? undefined : '4 4'}
        />
        {known ? (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={RING}
            strokeLinecap="round"
            strokeDasharray={`${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ) : null}
        <text className={styles.value} x={center} y={center} textAnchor="middle" dominantBaseline="central">
          {text}
        </text>
      </svg>
      {label === undefined ? null : <div className={styles.label}>{label}</div>}
      {footNote === undefined ? null : <div className={styles.caption}>{footNote}</div>}
    </div>
  );
}
