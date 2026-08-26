import type { ReactNode } from 'react';
import { cx } from '../../lib';
import { approxTextWidth, truncateToWidth } from './text';
import { useChartWidth } from './useChartWidth';
import styles from './Sparkline.module.css';

export interface SparklinePoint {
  t?: number;
  v: number;
}

export interface SparklineProps {
  /** 单序列。数字数组或 {t, v} 数组都行 */
  data?: ReadonlyArray<number | SparklinePoint>;
  /** data 的别名 */
  values?: ReadonlyArray<number | SparklinePoint>;
  /** 容器还没量出来时的兜底宽度 */
  width?: number;
  /** 高度，默认 24（DESIGN.md 第 4.2 节：24×N） */
  height?: number;
  /** 线色，默认 var(--accent) */
  color?: string;
  /** 没有数据时的一句中文说明 */
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
}

function toNumbers(input: ReadonlyArray<number | SparklinePoint> | undefined): number[] {
  if (!input) return [];
  const out: number[] = [];
  for (const item of input) {
    const value = typeof item === 'number' ? item : item.v;
    out.push(Number.isFinite(value) ? value : 0);
  }
  return out;
}

/** 单序列趋势线：无坐标轴，末点一个 2px 圆点（DESIGN.md 第 4.2 节） */
export function Sparkline({
  data,
  values,
  width = 120,
  height = 24,
  color = 'var(--accent)',
  emptyText = '这段时间没有调用',
  ariaLabel,
  className,
}: SparklineProps) {
  const [ref, measured] = useChartWidth(width);
  const series = toNumbers(data ?? values);
  const inset = 3;
  const top = inset;
  const bottom = height - inset;
  const noteSize = 11;

  let body: ReactNode;
  let label: string;
  if (series.length === 0) {
    // 空数据不留白方块：一条基线加一句说明（DESIGN.md 第 4.2 节的要求）
    const note = truncateToWidth(emptyText, Math.max(0, measured * 0.8), noteSize);
    const lineEnd = Math.max(0, measured - approxTextWidth(note, noteSize) - 6);
    body = (
      <>
        <line
          x1="0"
          y1={height / 2}
          x2={lineEnd}
          y2={height / 2}
          stroke="var(--border-subtle)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <text className={styles.note} x={measured} y={height / 2 + noteSize * 0.36} textAnchor="end">
          {note}
        </text>
      </>
    );
    label = emptyText;
  } else {
    const max = Math.max(...series);
    const min = Math.min(...series, 0);
    const span = max - min || 1;
    const step = series.length > 1 ? measured / (series.length - 1) : 0;
    const points = series.map((value, index) => {
      const x = series.length > 1 ? index * step : measured / 2;
      const y = bottom - ((value - min) / span) * (bottom - top);
      return [x, y] as const;
    });
    const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const last = points[points.length - 1];
    body = (
      <>
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
      </>
    );
    label = `趋势线，${series.length} 个点，峰值 ${max}`;
  }

  return (
    <div className={cx(styles.root, className)} ref={ref}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${measured} ${height}`}
        preserveAspectRatio="none"
        width={measured}
        height={height}
        role="img"
        aria-label={ariaLabel ?? label}
      >
        {body}
      </svg>
    </div>
  );
}
