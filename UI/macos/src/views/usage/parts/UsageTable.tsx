/**
 * 最近用量明细。
 *
 * 两个刻意的选择：
 *   1. 多一列「用量来源」——journal 的 source 区分「上游给的数字」和「本地估算」，
 *      这是一页讲 token 记账的视图里最该说清的一件事，藏起来就等于让估算值冒充实测值。
 *   2. 降级列是个按钮，点了跳诊断视图并把这一回合的码带过去；这里只报数量，不在两个视图
 *      各写一遍人话（文案唯一来源是 degradeCatalog）。
 */
import { Badge, StatusDot, Table, Td, Th } from '../../../components';
import type { BadgeTone, StatusToneInput } from '../../../components';
import { MISSING, formatTime, formatTokens } from '../../../lib';
import type { UsageRow } from '../../../types/contract';
import { SEVERITY_TONE } from '../../diagnostics/parts/aggregate';
import { worstSeverity } from '../../../data/degradeCatalog';
import styles from './UsageTable.module.css';

export interface UsageTableProps {
  rows: readonly UsageRow[];
  /** 点降级列：跳到诊断视图看这一回合到底降级了什么 */
  onInspectDegrade: (row: UsageRow) => void;
}

/** 协议格式的配色：anthropic 是原生（青），OpenAI 系是跨协议（紫），其余中性 */
function formatTone(format: string): BadgeTone {
  if (format === 'anthropic') return 'accent';
  if (format === 'openai_chat' || format === 'openai_responses') return 'violet';
  return 'neutral';
}

/** 用量来源：上游报的数才是实测，estimated 是本地按 token 估的，必须区分 */
function sourceView(source: string): { tone: StatusToneInput; text: string; title: string } {
  if (source === 'upstream') {
    return { tone: 'ok', text: '上游', title: '上游在响应里报了 usage，这些数字是实测值' };
  }
  if (source === 'estimated') {
    return { tone: 'degraded', text: '本地估算', title: '上游没报 usage，数字由本地估算，与账单可能有差' };
  }
  if (source === '') {
    return { tone: 'off', text: '未记录', title: 'journal 没写 source 字段，无法判断数字来自哪里' };
  }
  return { tone: 'off', text: source, title: `journal 里的 source 是 ${source}，本视图没有对应口径说明` };
}

export function UsageTable({ rows, onInspectDegrade }: UsageTableProps) {
  return (
    <Table stickyHeader minWidth={1040} aria-label="最近用量明细">
      <thead>
        <tr>
          <Th>时间</Th>
          <Th>渠道</Th>
          <Th>模型</Th>
          <Th>协议格式</Th>
          <Th>用量来源</Th>
          <Th numeric>输入</Th>
          <Th numeric>输出</Th>
          <Th numeric>缓存读</Th>
          <Th numeric>缓存写</Th>
          <Th>降级</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const source = sourceView(row.source);
          const worst = worstSeverity(row.deg);
          return (
            <tr key={`${row.ts}-${row.channel}-${row.model}-${index}`}>
              <Td mono title={formatTime(row.ts)}>
                {formatTime(row.ts)}
              </Td>
              <Td mono truncate title={row.channel === '' ? '流水未记录渠道名' : row.channel}>
                {row.channel === '' ? MISSING : row.channel}
              </Td>
              <Td mono truncate title={row.model === '' ? '流水未记录模型 id' : row.model}>
                {row.model === '' ? MISSING : row.model}
              </Td>
              <Td>
                <Badge tone={formatTone(row.format)}>{row.format === '' ? '未记录' : row.format}</Badge>
              </Td>
              <Td>
                <StatusDot tone={source.tone} title={source.title}>
                  {source.text}
                </StatusDot>
              </Td>
              <Td numeric>{formatTokens(row.in)}</Td>
              <Td numeric>{formatTokens(row.out)}</Td>
              <Td numeric>{formatTokens(row.cr)}</Td>
              <Td numeric>{formatTokens(row.cw)}</Td>
              <Td>
                {worst === null ? (
                  <span className={styles.clean} title="这一回合没有记录任何降级码">
                    {MISSING}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.degrade}
                    onClick={() => onInspectDegrade(row)}
                    title={`${row.deg.join('、')}\n点击到诊断视图看这几个码的人话解释`}
                  >
                    <StatusDot tone={SEVERITY_TONE[worst]}>{`${row.deg.length} 项`}</StatusDot>
                  </button>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
