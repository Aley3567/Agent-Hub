/**
 * 对话视图的左栏会话列表（DESIGN.md 4.5）。
 *
 * 选中标识沿用侧栏的「内缩圆角块」规范（左右各留 --sp-2、--radius-md、--bg-selected、
 * 文字转 accent），不另造标识、不补竖条；行间不画分隔线，靠间距分组。
 * 副行「来源 · 渠道 · 相对时间」是技术标识，走 mono fs-12 tertiary（DESIGN.md 2.3）。
 *
 * 只读这件事不靠颜色编码：历史会话那一行同时给锁形图标、文字「历史」与 title 说明，
 * 三处说同一件事；本地会话标「本地」并带上它绑的 hub。删除入口只给本地会话——历史是
 * 只读回放，Rust 侧同样拒绝删除。
 */
import { memo } from 'react';
import { Icon, IconButton } from '../../../components';
import { t } from '../../../i18n';
import { cx, formatRelative } from '../../../lib';
import type { Channel, ChatSession } from '../../../types/contract';
import styles from './SessionList.module.css';

export interface SessionListProps {
  /** 已按 updatedAt 倒序排好的会话 */
  sessions: ChatSession[];
  /** Channel.id → 渠道名，用于副行；未绑定或查不到时显示「未绑定渠道」 */
  channelName: (channelId: string | null) => string;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** 删除入口只给本地会话（历史只读，删不了） */
  onDelete: (session: ChatSession) => void;
}

/** 渠道名解析：channelId 为 null 或在渠道表里查不到，都按「未绑定渠道」显示 */
export function resolveChannelName(channels: Channel[], channelId: string | null): string {
  if (channelId === null) return '未绑定渠道';
  return channels.find((channel) => channel.appType === 'claude' && channel.id === channelId)?.name ?? '未绑定渠道';
}

function SessionList({ sessions, channelName, selectedId, onSelect, onDelete }: SessionListProps) {
  return (
    <ul className={styles.list} aria-label={t('会话列表')}>
      {sessions.map((session) => {
        const selected = session.id === selectedId;
        const history = session.source === 'history';
        return (
          <li key={session.id} className={styles.itemRow}>
            <button
              type="button"
              className={cx(styles.item, selected && styles.itemActive)}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(session.id)}
            >
              <span className={styles.itemTitle}>{session.title}</span>
              <span className={styles.itemMeta}>
                {history ? (
                  <span
                    className={styles.sourceReadOnly}
                    title={t('历史会话：只读回放本机 jsonl，不能发送，也不能删除')}
                  >
                    {/* 12px 是刻意的：副行行高是 --lh-12，20px 的默认图标会把这一行撑开 */}
                    <Icon name="lock" size={12} className={styles.sourceIcon} />
                    {t('历史')}
                  </span>
                ) : (
                  <span className={styles.source}>
                    {t('本地')} · {session.hubName ?? t('默认 hub')}
                  </span>
                )}
                {' · '}
                {channelName(session.channelId)} · {formatRelative(session.updatedAt)}
              </span>
            </button>
            {history ? null : (
              <IconButton
                variant="ghost"
                size="sm"
                icon="trash"
                className={styles.remove}
                aria-label={t('删除会话')}
                tooltip={t('删除这个本地会话')}
                onClick={() => onDelete(session)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default memo(SessionList);
