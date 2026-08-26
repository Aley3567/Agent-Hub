/**
 * 一条降级记录，可展开（DESIGN.md 第 4.4 节的呈现规则就是这个组件的全部规格）：
 *   人话标题在前，HUB_DEGRADE_ 原码紧跟其后（--fs-11 mono --text-tertiary，不隐藏、可搜可选）；
 *   展开后是三段式：发生了什么 / 对你的影响 / 建议动作；
 *   严重度用圆点 + 文字双重编码，lossy 额外把标题加粗；
 *   同一回合的多个码折叠成一行「+N」，展开看全部。
 *
 * 本组件不产出任何解释性文案——每一句都来自 degradeCatalog 的条目。
 */
import type { ReactNode } from 'react';
import { CodeBlock, Icon, StatusDot } from '../../../components';
import { SEVERITY_LABEL } from '../../../data/degradeCatalog';
import type { DegradeEntry } from '../../../data/degradeCatalog';
import { cx } from '../../../lib';
import { SEVERITY_TONE } from './aggregate';
import styles from './DegradeItem.module.css';

export interface DegradeItemProps {
  /** 至少一条；第一条是最严重的那个码，标题行显示它 */
  entries: readonly DegradeEntry[];
  /** 出现次数，按降级码聚合时给；按回合列时不给 */
  count?: number | null;
  /** 标题行右侧的补充信息：时间、渠道、模型、来源 */
  meta?: ReactNode;
  /** 展开区末尾追加的内容：出现记录 */
  footer?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}

export function DegradeItem({ entries, count = null, meta, footer, expanded, onToggle }: DegradeItemProps) {
  const head = entries[0];
  const extra = entries.length - 1;

  return (
    <li className={styles.item}>
      <div className={styles.header}>
        <button type="button" className={styles.toggle} aria-expanded={expanded} onClick={onToggle}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} className={styles.chevron} />
          <StatusDot tone={SEVERITY_TONE[head.severity]}>{SEVERITY_LABEL[head.severity]}</StatusDot>
          <span className={cx(styles.title, head.severity === 'lossy' && styles.lossy)}>{head.title}</span>
        </button>
        <span className={styles.code}>{head.code}</span>
        {extra > 0 ? (
          <button
            type="button"
            className={styles.extra}
            onClick={onToggle}
            title={`同一回合还记了 ${extra} 个降级码，展开看全部`}
          >
            {`+${extra}`}
          </button>
        ) : null}
        {count === null ? null : <span className={styles.count}>{`${count} 次`}</span>}
        {meta === undefined ? null : <span className={styles.meta}>{meta}</span>}
      </div>

      {expanded ? (
        <div className={styles.panel}>
          {entries.map((entry) => (
            <div key={entry.code} className={styles.block}>
              {entries.length > 1 ? (
                <div className={styles.blockHead}>
                  <StatusDot tone={SEVERITY_TONE[entry.severity]}>{SEVERITY_LABEL[entry.severity]}</StatusDot>
                  <span className={cx(styles.blockTitle, entry.severity === 'lossy' && styles.lossy)}>
                    {entry.title}
                  </span>
                  <span className={styles.code}>{entry.code}</span>
                </div>
              ) : null}
              <dl className={styles.facts}>
                <dt className={styles.term}>发生了什么</dt>
                <dd className={styles.text}>{entry.what}</dd>
                <dt className={styles.term}>对你的影响</dt>
                <dd className={styles.text}>{entry.impact}</dd>
                <dt className={styles.term}>建议动作</dt>
                <dd className={styles.text}>{entry.action}</dd>
              </dl>
            </div>
          ))}
          <CodeBlock
            code={entries.map((entry) => entry.code).join('\n')}
            label={entries.length > 1 ? '这一回合的全部降级码，可复制发给作者' : '降级码，可复制发给作者'}
            wrap
          />
          {footer}
        </div>
      ) : null}
    </li>
  );
}
