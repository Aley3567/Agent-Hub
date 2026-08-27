/**
 * 对话视图右栏的消息流（DESIGN.md 4.5）：独立滚动容器。
 *
 * 三种角色三种形态：
 *   · user      —— 右对齐窄块（--bg-elevated + --border-default），全站唯一的气泡，最大宽 70%；
 *   · assistant —— 无气泡正文流，左对齐全宽，模型名与时间戳 mono tabular-nums；
 *   · system    —— --bg-inset 小条，演示降级提示落在这里。
 *
 * 滚动纪律：新消息到达滚到底；用户上翻后停止跟随，滚回底部才恢复（onScroll 里按
 * 距底阈值判定）。流式渲染的每一拍也算「新内容到达」，跟随中同样滚底。
 *
 * 正在发送的消息（pending）由本组件做去重拼接：mock 会把用户消息与回复就地追加进
 * session.messages（同一数组引用，store 不触发重渲染），真实后端则等 refresh 后才有，
 * 所以渲染时先从 store 消息里剔除与 pending 相同的最后一条，再把 pending 追加到末尾——
 * 两种数据源下都不重不漏。匹配口径是 role + ts + content 全等，只剔最后一次出现，
 * 同一秒连发两条相同文本不会误删前一条。
 */
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { ChatMessage, ChatSession } from '../../../types/contract';
import { cx, formatTime, redactSecrets } from '../../../lib';
import styles from './MessageStream.module.css';

/** 一次进行中的发送：用户消息已本地回显；reply 到位后按 shown 逐字渲染 */
export interface PendingSend {
  sessionId: string;
  userMessage: ChatMessage;
  reply: ChatMessage | null;
  /** 回复已渲染的字符数；reply 为 null 时是思考态，只显示 caret-pulse 光标 */
  shown: number;
}

export interface MessageStreamProps {
  session: ChatSession;
  /** 当前选中的会话正在进行的发送；其他会话的 pending 与这里无关，传 null */
  pending: PendingSend | null;
  /** 递增信号：用户发出一条新消息时 +1，强制恢复跟随并滚到底 */
  followSignal: number;
}

/** 距底小于这个值视为「用户就在底部」，新内容到达时继续跟随 */
const FOLLOW_THRESHOLD_PX = 48;

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role && a.ts === b.ts && a.content === b.content;
}

/** 剔除与 target 全等的最后一次出现；没有匹配时原样返回 */
function withoutLastMatch(list: ChatMessage[], target: ChatMessage): ChatMessage[] {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (sameMessage(list[i], target)) {
      return [...list.slice(0, i), ...list.slice(i + 1)];
    }
  }
  return list;
}

function MessageStream({ session, pending, followSignal }: MessageStreamProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** 是否跟随到底部。滚动事件之外的状态变化不改它，避免用户上翻被拽回去 */
  const followRef = useRef(true);

  const visible = useMemo<ChatMessage[]>(() => {
    let list = session.messages;
    if (pending !== null) {
      list = withoutLastMatch(list, pending.userMessage);
      if (pending.reply !== null) list = withoutLastMatch(list, pending.reply);
      list = [...list, pending.userMessage];
    }
    return list;
  }, [session.messages, pending]);

  /** 换会话时回到跟随态并直接落底 */
  useLayoutEffect(() => {
    followRef.current = true;
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [session.id]);

  /** 新消息 / 流式每一拍：跟随中才滚底 */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, pending?.shown]);

  /** 用户发出新消息：无论之前翻到哪里都回到底部看自己的话 */
  useLayoutEffect(() => {
    if (followSignal === 0) return;
    followRef.current = true;
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [followSignal]);

  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
  };

  return (
    <div className={styles.stream} ref={scrollerRef} onScroll={onScroll} aria-label="消息流">
      {visible.map((message, index) => (
        <MessageRow key={`${message.ts}-${index}`} session={session} message={message} />
      ))}

      {pending !== null ? (
        pending.reply === null ? (
          /* 思考态：助手回复到达前，等待指示就是 caret-pulse 光标本身（DESIGN.md 4.5） */
          <div className={cx(styles.row, styles.assistantRow)}>
            <span className={cx(styles.caret, 'caret-pulse')} aria-label="正在等待回复" />
          </div>
        ) : (
          <div className={cx(styles.row, styles.assistantRow)}>
            <p className={styles.assistantText}>
              {/* 先过闸再截断：截断后再脱敏会让 token 前 24 个字符的片段逃过 LONG_RUN */}
              {redactSecrets(pending.reply.content).slice(0, pending.shown)}
              {/* 逐字出现是数据到达不是过渡；渲染中光标挂 caret-pulse（DESIGN.md 2.5 / 4.5） */}
              <span className={cx(styles.caret, 'caret-pulse')} aria-hidden="true" />
            </p>
            <p className={styles.meta}>
              {session.model} · {formatTime(pending.reply.ts, { seconds: false })}
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}

function MessageRow({ session, message }: { session: ChatSession; message: ChatMessage }) {
  // content 过第二道闸（CONTRACT.md §1.2）：第一道在 Rust/mock 落库前，这里兜底渲染前——
  // pending 本地回显的消息没过第一道，更不能裸渲。
  const content = redactSecrets(message.content);
  if (message.role === 'system') {
    return (
      <div className={cx(styles.row, styles.systemRow)}>
        <p className={styles.systemBar}>{content}</p>
      </div>
    );
  }
  if (message.role === 'user') {
    return (
      <div className={cx(styles.row, styles.userRow)}>
        <p className={styles.bubble}>{content}</p>
        <p className={styles.meta}>{formatTime(message.ts, { seconds: false })}</p>
      </div>
    );
  }
  return (
    <div className={cx(styles.row, styles.assistantRow)}>
      <p className={styles.assistantText}>{content}</p>
      <p className={styles.meta}>
        {session.model} · {formatTime(message.ts, { seconds: false })}
      </p>
    </div>
  );
}

export default memo(MessageStream);
