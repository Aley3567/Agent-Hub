/**
 * 对话视图的左栏会话列表（DESIGN.md 4.5）。
 *
 * 选中标识沿用侧栏的「内缩圆角块」规范（左右各留 --sp-2、--radius-md、--bg-selected、
 * 文字转 accent），不另造标识、不补竖条；行间不画分隔线，靠间距分组。
 * 副行「渠道名 · 相对时间」是技术标识，走 mono fs-12 tertiary（DESIGN.md 2.3）。
 */
import { memo } from 'react';
import type { Channel, ChatSession } from '../../../types/contract';
import { cx, formatRelative } from '../../../lib';
import styles from './SessionList.module.css';

export interface SessionListProps {
  /** 已按 updatedAt 倒序排好的会话 */
  sessions: ChatSession[];
  /** Channel.id → 渠道名，用于副行；未绑定或查不到时显示「未绑定渠道」 */
  channelName: (channelId: string | null) => string;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}

/** 渠道名解析：channelId 为 null 或在渠道表里查不到，都按「未绑定渠道」显示 */
export function resolveChannelName(channels: Channel[], channelId: string | null): string {
  if (channelId === null) return '未绑定渠道';
  return channels.find((channel) => channel.id === channelId)?.name ?? '未绑定渠道';
}

function SessionList({ sessions, channelName, selectedId, onSelect }: SessionListProps) {
  return (
    <ul className={styles.list} aria-label="会话列表">
      {sessions.map((session) => {
        const selected = session.id === selectedId;
        return (
          <li key={session.id}>
            <button
              type="button"
              className={cx(styles.item, selected && styles.itemActive)}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(session.id)}
            >
              <span className={styles.itemTitle}>{session.title}</span>
              <span className={styles.itemMeta}>
                {channelName(session.channelId)} · {formatRelative(session.updatedAt)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default memo(SessionList);
