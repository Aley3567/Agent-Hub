import { useState } from 'react';
import type { MouseEvent } from 'react';
import { cx, formatTime, formatTokens } from '../../lib';
import { truncateToWidth } from './text';
import { useChartWidth } from './useChartWidth';
import styles from './TimeSeries.module.css';

/** 字段名与 UsageSummary.series 逐字一致，调用方可以直接把它塞进来 */
export interface TimeSeriesPoint {
  t: number;
  in?: number | null;
  out?: number | null;
  cr?: number | null;
  turns?: number | null;
  cost?: number | null;
}

export type TimeSeriesKey = 'in' | 'out' | 'cr' | 'turns';

export interface SecondaryAxis {
  key: 'cost';
  label: string;
  /** 副轴刻度与浮层数值的格式化 */
  formatValue: (value: number) => string;
}

export interface TimeSeriesProps {
  data?: ReadonlyArray<TimeSeriesPoint>;
  /** data 的别名 */
  points?: ReadonlyArray<TimeSeriesPoint>;
  /** 要画的序列，默认输入、输出、缓存读三条 */
  series?: readonly TimeSeriesKey[];
  /** 桶宽，决定 X 轴标签形态 */
  granularity?: 'hour' | 'day';
  height?: number;
  formatValue?: (value: number) => string;
  /** 可选副轴：成本红虚线，右轴 3 刻度 */
  secondary?: SecondaryAxis;
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
}

/** 序列语义固定（DESIGN.md 第 4.2 节）：输入=青、输出=紫、缓存=灰；成本=红虚线（语义色，不计入 3 色限制） */
const META: Record<TimeSeriesKey | 'cost', { label: string; color: string }> = {
  in: { label: '输入', color: 'var(--accent)' },
  out: { label: '输出', color: 'var(--violet)' },
  cr: { label: '缓存读', color: 'var(--text-tertiary)' },
  turns: { label: '回合', color: 'var(--text-tertiary)' },
  cost: { label: '成本', color: 'var(--danger)' },
};

/* SVG 内部坐标 */
const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const PAD_RIGHT_SECONDARY = 42;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const TICK_SIZE = 11;
/** DESIGN.md 第 4.2 节：Y 轴 3 条刻度线 */
const TICK_FRACTIONS = [1, 2 / 3, 1 / 3] as const;

function valueAt(point: TimeSeriesPoint, key: TimeSeriesKey): number {
  const raw = point[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function secondaryValueAt(point: TimeSeriesPoint, key: 'cost'): number | null {
  const raw = point[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function tickLabel(ts: number, granularity: 'hour' | 'day'): string {
  const date = new Date(Math.abs(ts) > 1e11 ? ts : ts * 1000);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return granularity === 'hour'
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把 cost 序列拆成多段，null 处断点，不画 0 冒充 */
function buildSecondarySegments(
  rows: readonly TimeSeriesPoint[],
  xAt: (index: number) => number,
  yAt: (value: number) => number,
): string[] {
  const segments: string[] = [];
  let current = '';
  rows.forEach((point, index) => {
    const value = secondaryValueAt(point, 'cost');
    if (value === null) {
      if (current !== '') {
        segments.push(current);
        current = '';
      }
      return;
    }
    const command = current === '' ? 'M' : 'L';
    current += `${command}${xAt(index).toFixed(2)} ${yAt(value).toFixed(2)}`;
  });
  if (current !== '') segments.push(current);
  return segments;
}

/** 折线 + 面积（首序列填 8% accent），带 Y 轴虚线刻度、X 轴时间标签与 hover 参考线 */
export function TimeSeries({
  data,
  points,
  series = ['in', 'out', 'cr'],
  granularity = 'day',
  height = 200,
  formatValue = formatTokens,
  secondary,
  emptyText = '这段时间没有流水，跑一次会话后回来看',
  ariaLabel,
  className,
}: TimeSeriesProps) {
  const [ref, width] = useChartWidth(640);
  const [hover, setHover] = useState<number | null>(null);
  const rows = data ?? points ?? [];

  const padRight = secondary ? PAD_RIGHT_SECONDARY : PAD_RIGHT;
  const plotWidth = Math.max(24, width - PAD_LEFT - padRight);
  const plotHeight = Math.max(24, height - PAD_TOP - PAD_BOTTOM);
  const baseY = PAD_TOP + plotHeight;

  const secondaryValues = secondary
    ? rows.map((point) => secondaryValueAt(point, secondary.key)).filter((v): v is number => v !== null)
    : [];
  const hasSecondary = secondaryValues.length > 0;
  const maxSecondary = hasSecondary ? Math.max(1, ...secondaryValues) : 1;

  if (rows.length === 0) {
    return (
      <div className={cx(styles.root, className)} ref={ref}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel ?? emptyText}
        >
          <line
            x1={PAD_LEFT}
            y1={baseY}
            x2={width - padRight}
            y2={baseY}
            stroke="var(--border-subtle)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <text className={styles.emptyText} x={width / 2} y={PAD_TOP + plotHeight / 2} textAnchor="middle">
            {truncateToWidth(emptyText, plotWidth, TICK_SIZE + 1)}
          </text>
        </svg>
      </div>
    );
  }

  const maxValue = Math.max(
    1,
    ...rows.map((point) => Math.max(...series.map((key) => valueAt(point, key)))),
  );
  const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : 0;
  const xAt = (index: number) => (rows.length > 1 ? PAD_LEFT + index * stepX : PAD_LEFT + plotWidth / 2);
  const yAt = (value: number) => baseY - (value / maxValue) * plotHeight;
  const ySecAt = (value: number) => baseY - (value / maxSecondary) * plotHeight;

  const tickCount = Math.min(rows.length, 5);
  const tickIndexes = Array.from({ length: tickCount }, (_unused, i) =>
    tickCount === 1 ? 0 : Math.round((i * (rows.length - 1)) / (tickCount - 1)),
  );

  const hoverIndex = hover === null ? null : Math.max(0, Math.min(rows.length - 1, hover));
  const hoverPoint = hoverIndex === null ? null : rows[hoverIndex];
  const hoverX = hoverIndex === null ? 0 : xAt(hoverIndex);
  const hoverSecondary = hoverPoint && secondary ? secondaryValueAt(hoverPoint, secondary.key) : null;

  function handleMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (rows.length === 1 || stepX === 0) {
      setHover(0);
      return;
    }
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round((x - PAD_LEFT) / stepX))));
  }

  const legendKeys: Array<TimeSeriesKey | 'cost'> = [...series];
  if (hasSecondary) legendKeys.push('cost');

  return (
    <div className={cx(styles.root, className)} ref={ref}>
      <ul className={styles.legend}>
        {legendKeys.map((key) => (
          <li key={key} className={styles.legendItem}>
            <span
              className={styles.swatch}
              style={{ background: META[key].color }}
              aria-hidden="true"
            />
            {META[key].label}
          </li>
        ))}
      </ul>
      <div className={styles.plot}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          width={width}
          height={height}
          role="img"
          aria-label={
            ariaLabel ??
            `用量走势，${rows.length} 个桶，峰值 ${formatValue(maxValue)}${hasSecondary ? `，成本峰值 ${secondary?.formatValue(maxSecondary)}` : ''}`
          }
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {TICK_FRACTIONS.map((fraction) => {
            const value = maxValue * fraction;
            const y = yAt(value);
            return (
              <g key={fraction}>
                <line
                  x1={PAD_LEFT}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="var(--border-subtle)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <text className={styles.tick} x={PAD_LEFT - 6} y={y} textAnchor="end" dominantBaseline="central">
                  {formatValue(value)}
                </text>
              </g>
            );
          })}
          <line
            x1={PAD_LEFT}
            y1={baseY}
            x2={width - padRight}
            y2={baseY}
            stroke="var(--border-subtle)"
            strokeWidth="1"
          />

          {hasSecondary
            ? TICK_FRACTIONS.map((fraction) => {
                const value = maxSecondary * fraction;
                const y = ySecAt(value);
                return (
                  <g key={`sec-${fraction}`}>
                    <text
                      className={styles.tick}
                      x={width - padRight + 6}
                      y={y}
                      textAnchor="start"
                      dominantBaseline="central"
                    >
                      {secondary?.formatValue(value)}
                    </text>
                  </g>
                );
              })
            : null}

          {series.map((key, seriesIndex) => {
            const line = rows
              .map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(index).toFixed(2)} ${yAt(valueAt(point, key)).toFixed(2)}`)
              .join(' ');
            const area = `${line} L${xAt(rows.length - 1).toFixed(2)} ${baseY} L${xAt(0).toFixed(2)} ${baseY} Z`;
            return (
              <g key={key}>
                {seriesIndex === 0 ? <path d={area} fill={META[key].color} fillOpacity="0.08" stroke="none" /> : null}
                <path
                  d={line}
                  fill="none"
                  stroke={META[key].color}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {hasSecondary
            ? buildSecondarySegments(rows, xAt, ySecAt).map((d, index) => (
                <path
                  key={`cost-${index}`}
                  d={d}
                  fill="none"
                  stroke={META.cost.color}
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))
            : null}

          {tickIndexes.map((index) => (
            <text
              key={index}
              className={styles.tick}
              x={xAt(index)}
              y={height - PAD_BOTTOM / 2}
              textAnchor={index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}
              dominantBaseline="central"
            >
              {tickLabel(rows[index].t, granularity)}
            </text>
          ))}

          {hoverIndex === null || hoverPoint === null ? null : (
            <g>
              <line
                x1={hoverX}
                y1={PAD_TOP}
                x2={hoverX}
                y2={baseY}
                stroke="var(--border-strong)"
                strokeWidth="1"
              />
              {series.map((key) => (
                <circle
                  key={key}
                  cx={hoverX}
                  cy={yAt(valueAt(hoverPoint, key))}
                  r="2.5"
                  fill="var(--bg-base)"
                  stroke={META[key].color}
                  strokeWidth="1.5"
                />
              ))}
              {hoverSecondary !== null ? (
                <circle
                  cx={hoverX}
                  cy={ySecAt(hoverSecondary)}
                  r="2.5"
                  fill="var(--bg-base)"
                  stroke={META.cost.color}
                  strokeWidth="1.5"
                />
              ) : null}
            </g>
          )}
        </svg>

        {hoverIndex === null || hoverPoint === null ? null : (
          <div
            className={cx(styles.tip, hoverX > width * 0.62 && styles.tipFlip)}
            style={{ left: `${hoverX}px`, top: `${PAD_TOP}px` }}
          >
            <div className={styles.tipTime}>{formatTime(hoverPoint.t, { seconds: false })}</div>
            {series.map((key) => (
              <div key={key} className={styles.tipRow}>
                <span className={styles.swatch} style={{ background: META[key].color }} aria-hidden="true" />
                <span className={styles.tipLabel}>{META[key].label}</span>
                <span className={styles.tipValue}>{formatValue(valueAt(hoverPoint, key))}</span>
              </div>
            ))}
            {hoverSecondary !== null && secondary ? (
              <div className={styles.tipRow}>
                <span className={styles.swatch} style={{ background: META.cost.color }} aria-hidden="true" />
                <span className={styles.tipLabel}>{secondary.label}</span>
                <span className={styles.tipValue}>{secondary.formatValue(hoverSecondary)}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 逐桶数值只在 hover 浮层里，键盘够不着；补一张视觉隐藏的数据表兜底（DESIGN.md 6 节） */}
      <table className="sr-only">
        <caption>{ariaLabel ?? '用量走势'}：逐桶数值</caption>
        <thead>
          <tr>
            <th scope="col">时间</th>
            {series.map((key) => (
              <th key={key} scope="col">
                {META[key].label}
              </th>
            ))}
            {secondary ? <th scope="col">{secondary.label}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => (
            <tr key={point.t}>
              <th scope="row">{formatTime(point.t, { seconds: false })}</th>
              {series.map((key) => (
                <td key={key}>{formatValue(valueAt(point, key))}</td>
              ))}
              {secondary ? (
                <td>
                  {secondaryValueAt(point, secondary.key) === null
                    ? '—'
                    : secondary.formatValue(secondaryValueAt(point, secondary.key)!)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
