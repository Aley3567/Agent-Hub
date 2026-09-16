/**
 * 对话视图右栏的消息流（DESIGN.md 4.5）：独立滚动容器。
 *
 * 三种角色三种形态：
 *   · user      —— 右对齐窄块（--bg-elevated + --border-default），全站唯一的气泡，最大宽 70%；
 *   · assistant —— 无气泡正文流，左对齐全宽，模型名与时间戳 mono tabular-nums；
 *   · system    —— --bg-inset 小条，上游截断说明、新建会话的说明都落在这里。
 *
 * 流式正文是 store 里的真实增量（chatStream.text），逐段到达、这里整段渲染。脱敏必须
 * 整段扫（CONTRACT.md §1.2）：这段文本在本地累积，没过 Rust 侧第一道闸，而一个被切成
 * 多段的长凭证串，只有把整段拼起来才认得出——逐段各扫一遍会让每一段都短于长串规则的阈值。
 *
 * 滚动纪律：新消息到达滚到底；用户上翻后停止跟随，滚回底部才恢复（onScroll 里按
 * 距底阈值判定）。流式的每一段到达也算「新内容到达」，跟随中同样滚底。
 *
 * 本地回显（pending）的拼接：真值里还没有这条用户消息时才追加到末尾；一旦 store 里有了，
 * 就整条交给 store 渲染——既不重复，也不会把用户消息排到回复后面去。
 */
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { ChatMessage, ChatSession } from '../../../types/contract';
import { cx, formatTime, redactSecrets } from '../../../lib';
import styles from './MessageStream.module.css';

/** 一次进行中的发送：用户消息已本地回显，正文由 store 的 chatStream 增量渲染 */
export interface PendingSend {
  sessionId: string;
  userMessage: ChatMessage;
}

export interface MessageStreamProps {
  session: ChatSession;
  /**
   * 这条会话在途流已收到的正文。null = 没有在途流；'' = 流刚起、还没有首个增量
   * （等待指示就是 caret-pulse 光标本身）
   */
  stream: string | null;
  /** 当前选中会话正在进行的发送（本地回显）；其他会话的 pending 与这里无关，传 null */
  pending: PendingSend | null;
  /** 递增信号：用户发出一条新消息时 +1，强制恢复跟随并滚到底 */
  followSignal: number;
}

/** 距底小于这个值视为「用户就在底部」，新内容到达时继续跟随 */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * 是否同一条消息：role + 正文。正文各过一遍第二道闸再比——落库的是 Rust 侧脱敏后的文本，
 * 本地回显是用户原样输入，用户正文里带凭证形状的串时两者原文不同，不脱敏就会永远配不上对，
 * 本地回显赖着不走。不含 ts：双源时钟恰跨秒边界就全等失配。
 */
export function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.role === b.role && redactSecrets(a.content) === redactSecrets(b.content);
}

function MessageStream({ session, stream, pending, followSignal }: MessageStreamProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** 是否跟随到底部。滚动事件之外的状态变化不改它，避免用户上翻被拽回去 */
  const followRef = useRef(true);

  const visible = useMemo<ChatMessage[]>(() => {
    if (pending === null) return session.messages;
    if (session.messages.some((message) => sameMessage(message, pending.userMessage))) {
      return session.messages;
    }
    return [...session.messages, pending.userMessage];
  }, [session.messages, pending]);

  /** 换会话时回到跟随态并直接落底 */
  useLayoutEffect(() => {
    followRef.current = true;
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [session.id]);

  /** 新消息 / 流式每一段：跟随中才滚底 */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, stream]);

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

      {stream === '' ? (
        /* 思考态：首个增量到达前，等待指示就是 caret-pulse 光标本身（DESIGN.md 4.5） */
        <div className={cx(styles.row, styles.assistantRow)}>
          <span className={cx(styles.caret, 'caret-pulse')} aria-label="正在等待回复" />
        </div>
      ) : null}

      {stream !== null && stream !== '' ? (
        <div className={cx(styles.row, styles.assistantRow)}>
          <p className={styles.assistantText}>
            {/* 第二道闸（CONTRACT.md §1.2）：这段正文没过第一道，渲染前整段过一遍 */}
            {redactSecrets(stream)}
            {/* 逐段出现是数据到达不是过渡；流未终结时光标挂 caret-pulse（DESIGN.md 2.5 / 4.5） */}
            <span className={cx(styles.caret, 'caret-pulse')} aria-hidden="true" />
          </p>
          <p className={styles.meta}>{session.model}</p>
        </div>
      ) : null}
    </div>
  );
}

function MessageRow({ session, message }: { session: ChatSession; message: ChatMessage }) {
  // content 过第二道闸（CONTRACT.md §1.2）：第一道在 Rust 落库前，这里兜底渲染前——
  // 本地回显的消息没过第一道，更不能裸渲。
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
