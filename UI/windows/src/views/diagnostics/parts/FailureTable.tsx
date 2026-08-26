/**
 * 失败区表格。每行可展开：表格里放机器字段（状态、阶段、异常类型），
 * 展开后放人话与原文——原文一律走 CodeBlock，方便整段复制去追问上游。
 *
 * 状态列绝不留空白：没有 HTTP 状态但有异常类型时显示「连接中断」加一行「上游未给出错误体」，
 * 判定逻辑全在 failure.ts，这里只负责摆放。
 */
import { Fragment } from 'react';
import { Badge, Button, CodeBlock, Icon, StatusDot, Table, Td, Th } from '../../../components';
import type { BadgeTone } from '../../../components';
import { MISSING, formatTime } from '../../../lib';
import styles from './FailureTable.module.css';
import type { FailureItem } from './failure';

export interface FailureTableProps {
  items: readonly FailureItem[];
  /** 已展开的行 key */
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** 这条失败同时记了降级码时，跳到降级区只看这几个码 */
  onInspectDegrade: (codes: readonly string[]) => void;
}

const COLUMN_COUNT = 9;

function formatTone(format: string | null): BadgeTone {
  if (format === 'anthropic') return 'accent';
  if (format === 'openai_chat' || format === 'openai_responses') return 'violet';
  return 'neutral';
}

export function FailureTable({ items, expanded, onToggle, onInspectDegrade }: FailureTableProps) {
  return (
    <Table stickyHeader minWidth={1080} aria-label="失败记录">
      <thead>
        <tr>
          <Th aria-label="展开详情" />
          <Th>时间</Th>
          <Th>阶段</Th>
          <Th>渠道</Th>
          <Th>模型</Th>
          <Th>协议格式</Th>
          <Th>HTTP 状态</Th>
          <Th>异常类型</Th>
          <Th>原因</Th>
        </tr>
      </thead>
      <tbody>
        {items.map(({ key, row, narrative }) => {
          const open = expanded.has(key);
          return (
            <Fragment key={key}>
              <tr>
                <Td>
                  <button
                    type="button"
                    className={styles.toggle}
                    aria-expanded={open}
                    aria-label={open ? '收起这条失败的详情' : '展开这条失败的详情'}
                    onClick={() => onToggle(key)}
                  >
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                  </button>
                </Td>
                <Td mono>{formatTime(row.ts)}</Td>
                <Td>
                  <span className={styles.stack}>
                    <span className={styles.primary}>{narrative.phaseLabel}</span>
                    {narrative.phaseRaw === null ? null : (
                      <span className={styles.machine}>{narrative.phaseRaw}</span>
                    )}
                  </span>
                </Td>
                <Td mono truncate title={row.channel ?? '流水未记录渠道'}>
                  {row.channel ?? MISSING}
                </Td>
                <Td mono truncate title={row.model ?? '流水未记录模型'}>
                  {row.model ?? MISSING}
                </Td>
                <Td>
                  <Badge tone={formatTone(row.format)}>{row.format ?? '未记录'}</Badge>
                </Td>
                <Td>
                  <span className={styles.stack}>
                    <StatusDot tone={narrative.tone}>{narrative.statusText}</StatusDot>
                    {narrative.statusNote === null ? null : (
                      <span className={styles.note}>{narrative.statusNote}</span>
                    )}
                  </span>
                </Td>
                <Td mono truncate title={row.exc ?? '没有记录异常类型'}>
                  {row.exc ?? MISSING}
                </Td>
                <Td truncate title={narrative.headline}>
                  {narrative.headline}
                </Td>
              </tr>
              {open ? (
                <tr>
                  <td className={styles.detailCell} colSpan={COLUMN_COUNT}>
                    <div className={styles.detail}>
                      <dl className={styles.facts}>
                        <dt className={styles.term}>这条失败在说什么</dt>
                        <dd className={styles.text}>{narrative.explain}</dd>
                        <dt className={styles.term}>下一步</dt>
                        <dd className={styles.text}>{narrative.hint}</dd>
                      </dl>
                      {narrative.message === null ? (
                        <p className={styles.text}>错误流水没有记下 message，能看到的线索只有上面这几列。</p>
                      ) : (
                        <CodeBlock code={narrative.message} label="错误流水原文（已脱敏）" wrap />
                      )}
                      <div className={styles.tags}>
                        {row.code === null || row.code === '' ? null : (
                          <Badge tone="neutral" title="上游给出的错误 code">{`code ${row.code}`}</Badge>
                        )}
                        {row.route === null || row.route === '' ? null : (
                          <Badge tone="neutral" title="这次请求命中的路由">{`route ${row.route}`}</Badge>
                        )}
                        {row.deg.map((code) => (
                          <Badge key={code} tone="warn">
                            {code}
                          </Badge>
                        ))}
                        {row.deg.length === 0 ? null : (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="diagnostics"
                            onClick={() => onInspectDegrade(row.deg)}
                          >
                            到降级区看这几个码
                          </Button>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}
