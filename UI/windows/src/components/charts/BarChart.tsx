import { cx, formatTokens } from '../../lib';
import { truncateToWidth } from './text';
import { useChartWidth } from './useChartWidth';
import styles from './BarChart.module.css';

export interface BarChartDatum {
  /** 行标签（渠道名 / 模型 id）。key 是它的别名 */
  label?: string;
  key?: string;
  /** 堆叠分段，顺序即配色顺序：输入 → 输出 → 缓存 */
  values?: ReadonlyArray<number | null>;
  /** 单序列时给这个就够 */
  value?: number | null;
  /** 悬浮完整说明，默认用 label */
  title?: string;
}

export interface BarChartProps {
  data: ReadonlyArray<BarChartDatum>;
  /** 分段名，默认「输入 / 输出 / 缓存」 */
  seriesLabels?: readonly string[];
  /** 分段色，默认 accent → violet → text-tertiary（DESIGN.md 第 4.2 节固定序列语义） */
  colors?: readonly string[];
  /** 指定横轴上限；默认取各行合计的最大值 */
  max?: number;
  /** 只显示前 N 行 */
  topN?: number;
  /** 数值格式化，默认 formatTokens */
  formatValue?: (value: number) => string;
  /** 图例，默认在分段多于一段时显示 */
  legend?: boolean;
  emptyText?: string;
  ariaLabel?: string;
  className?: string;
}

const DEFAULT_COLORS = ['var(--accent)', 'var(--violet)', 'var(--text-tertiary)'] as const;
const DEFAULT_SERIES = ['输入', '输出', '缓存'] as const;

/* SVG 内部坐标（DESIGN.md 第 4.2 节：条高 20、圆角 2） */
const BAR_HEIGHT = 20;
const ROW_GAP = 8;
const LABEL_SIZE = 12;
const VALUE_WIDTH = 72;
const GUTTER = 8;

function segmentsOf(datum: BarChartDatum): number[] {
  if (datum.values && datum.values.length > 0) {
    return datum.values.map((value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0));
  }
  const single = datum.value;
  return [typeof single === 'number' && Number.isFinite(single) ? Math.max(0, single) : 0];
}

/** 横向条形图，多序列堆叠。值标签在条右侧，等宽 */
export function BarChart({
  data,
  seriesLabels = DEFAULT_SERIES,
  colors = DEFAULT_COLORS,
  max,
  topN,
  formatValue = formatTokens,
  legend,
  emptyText = '这段时间没有产生任何用量',
  ariaLabel,
  className,
}: BarChartProps) {
  const [ref, width] = useChartWidth(560);
  const rows = topN === undefined ? data : data.slice(0, topN);
  const prepared = rows.map((datum) => {
    const segments = segmentsOf(datum);
    return {
      label: datum.label ?? datum.key ?? '未标注',
      title: datum.title,
      segments,
      total: segments.reduce((sum, value) => sum + value, 0),
    };
  });

  if (prepared.length === 0) {
    return (
      <div className={cx(styles.root, className)} ref={ref}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${width} ${BAR_HEIGHT + ROW_GAP}`}
          preserveAspectRatio="none"
          width={width}
          height={BAR_HEIGHT + ROW_GAP}
          role="img"
          aria-label={ariaLabel ?? emptyText}
        >
          <line
            x1="0"
            y1={BAR_HEIGHT / 2 + 2}
            x2={width}
            y2={BAR_HEIGHT / 2 + 2}
            stroke="var(--border-subtle)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <text className={styles.empty} x={width / 2} y={BAR_HEIGHT / 2 + 2 + LABEL_SIZE + 2} textAnchor="middle">
            {truncateToWidth(emptyText, width, LABEL_SIZE)}
          </text>
        </svg>
      </div>
    );
  }

  const seriesCount = prepared.reduce((count, row) => Math.max(count, row.segments.length), 1);
  const showLegend = legend ?? seriesCount > 1;
  const labelWidth = Math.max(72, Math.min(180, width * 0.28));
  const barX = labelWidth + GUTTER;
  const barWidth = Math.max(16, width - labelWidth - VALUE_WIDTH - GUTTER * 2);
  const scaleMax = Math.max(max ?? 0, ...prepared.map((row) => row.total), 1);
  const height = prepared.length * (BAR_HEIGHT + ROW_GAP) - ROW_GAP;

  return (
    <div className={cx(styles.root, className)} ref={ref}>
      {showLegend ? (
        <ul className={styles.legend}>
          {Array.from({ length: seriesCount }, (_unused, index) => (
            <li key={index} className={styles.legendItem}>
              <span
                className={styles.swatch}
                style={{ background: colors[index % colors.length] }}
                aria-hidden="true"
              />
              {seriesLabels[index] ?? `序列 ${index + 1}`}
            </li>
          ))}
        </ul>
      ) : null}
      <svg
        className={styles.svg}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? `横向条形图，共 ${prepared.length} 行`}
      >
        {prepared.map((row, rowIndex) => {
          const y = rowIndex * (BAR_HEIGHT + ROW_GAP);
          let offset = 0;
          return (
            <g key={`${row.label}-${rowIndex}`} className={styles.row}>
              <title>{row.title ?? `${row.label}：${formatValue(row.total)}`}</title>
              <text
                className={styles.label}
                x="0"
                y={y + BAR_HEIGHT / 2}
                dominantBaseline="central"
              >
                {truncateToWidth(row.label, labelWidth, LABEL_SIZE)}
              </text>
              {/* 底槽的 fill 与 hover 换色都交给 CSS（见 BarChart.module.css 的 .track） */}
              <rect className={styles.track} x={barX} y={y} width={barWidth} height={BAR_HEIGHT} rx="2" />
              {row.segments.map((value, index) => {
                if (value <= 0) return null;
                const segmentWidth = (value / scaleMax) * barWidth;
                const x = barX + offset;
                offset += segmentWidth;
                return (
                  <rect
                    key={index}
                    x={x}
                    y={y}
                    width={Math.max(1, segmentWidth)}
                    height={BAR_HEIGHT}
                    rx="2"
                    fill={colors[index % colors.length]}
                  />
                );
              })}
              <text
                className={styles.value}
                x={width}
                y={y + BAR_HEIGHT / 2}
                textAnchor="end"
                dominantBaseline="central"
              >
                {truncateToWidth(formatValue(row.total), VALUE_WIDTH, LABEL_SIZE)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* 行明细原先只在 SVG <title> 里，键盘与读屏够不着；补一张视觉隐藏的数据表兜底（DESIGN.md 6 节） */}
      <table className="sr-only">
        <caption>{ariaLabel ?? '横向条形图'}：各行明细</caption>
        <thead>
          <tr>
            <th scope="col">项目</th>
            {Array.from({ length: seriesCount }, (_unused, index) => (
              <th key={index} scope="col">
                {seriesLabels[index] ?? `序列 ${index + 1}`}
              </th>
            ))}
            {seriesCount > 1 ? <th scope="col">合计</th> : null}
          </tr>
        </thead>
        <tbody>
          {prepared.map((row, rowIndex) => (
            <tr key={`${row.label}-${rowIndex}`}>
              <th scope="row">{row.title ?? row.label}</th>
              {Array.from({ length: seriesCount }, (_unused, index) => (
                <td key={index}>{formatValue(row.segments[index] ?? 0)}</td>
              ))}
              {seriesCount > 1 ? <td>{formatValue(row.total)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
