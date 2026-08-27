/**
 * 对话视图（ViewId chat，DESIGN.md 4.5）：会话列表 + 消息流 + composer 的工作台三件套。
 * 本轮是 UI 骨架 + 演示数据，顶部常驻「演示数据——对话尚未接入后端」横幅
 * （假数据必须显式标明，对齐 CONTRACT.md 4 节的徽章精神；接入后端后整条移除）。
 *
 * 本视图满宽且自身接管滚动——会话列表与消息流是两个独立滚动容器，壳层内容区不滚，
 * 是「唯一滚动容器」（DESIGN.md 3 节）的唯一视图级例外。落地方式：壳层的滚动容器
 * （App.module.css 的 .scroll）高度由壳层自己定，这里用 ResizeObserver 量出它的可视高，
 * 减去它的上下 padding 后写成本视图的固定高——内容高度与可视高相等，壳层就没有东西可滚，
 * 滚动只发生在两个栏各自内部。用测量而不用 calc(100vh - …) 是因为 ViewHeader 的高度
 * 不是 token，写死会在壳层改版或界面缩放（body zoom）时漂移。
 *
 * 数据纪律：
 *   · 会话与消息只走 useApp 的 chatSessions / sendChatMessage，不在视图里造会话数据；
 *   · sendChatMessage 失败（含演示实现报「找不到会话」）时 catch 后 refresh('chat')
 *     把列表拉回真值，原因原文进 toast.error；
 *   · 收到完整 ChatMessage 后用定时器逐字渲染——这是数据到达不是过渡，不占动效名额
 *     （DESIGN.md 2.5「上限与例外」）；渲染中与等待中的等待指示都只有 caret-pulse 光标；
 *   · aria-live 播报只在整条回复完成时做一次，不逐字播报（DESIGN.md 4.5）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Spinner } from '../../components';
import { errorText, useApp } from '../../store';
import { useNav } from '../../store/nav';
import { useToast } from '../../store/toast';
import { useAnnouncer } from '../../shell/announce';
import Composer from './parts/Composer';
import MessageStream, { type PendingSend } from './parts/MessageStream';
import SessionList, { resolveChannelName } from './parts/SessionList';
import styles from './index.module.css';

/** 流式渲染节奏：每拍补两个字符。这是数据到达的呈现速度，不是过渡时长（DESIGN.md 4.5） */
const STREAM_CHARS_PER_TICK = 2;
const STREAM_TICK_MS = 24;

export default function ChatView() {
  const sessions = useApp((state) => state.chatSessions);
  const channels = useApp((state) => state.channels);
  const loading = useApp((state) => state.loading.chat === true);
  const reason = useApp((state) => state.error.chat ?? null);
  const loaded = useApp((state) => state.loadedKeys.chat === true);
  const refresh = useApp((state) => state.refresh);
  const sendChatMessage = useApp((state) => state.sendChatMessage);
  const registerViewReload = useNav((state) => state.registerViewReload);
  const toastError = useToast((state) => state.error);
  const announce = useAnnouncer((state) => state.announce);

  const rootRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [followSignal, setFollowSignal] = useState(0);

  /* 视图刷新注册：壳层 ⌘R / 刷新按钮转发到这里；卸载时必须传 null 注销（CONTRACT.md 6.2） */
  useEffect(() => {
    registerViewReload('chat', () => refresh('chat'));
    return () => registerViewReload('chat', null);
  }, [registerViewReload, refresh]);

  /* 让本视图正好填满壳层滚动容器的可视高，使滚动只发生在会话列表与消息流内部 */
  useEffect(() => {
    const el = rootRef.current;
    // DOM 链是 .scroll > .container > .view-enter > 视图根（App.tsx 的挂载结构），
    // 要量的目标是带上下 padding 的 .scroll——少走一层会量到 .container：它没有
    // padding（减法空转），高度又被内容撑死，窗口 resize 时 ResizeObserver 量的是
    // 自己，fit 永不重算，整页跟着 .scroll 滚、composer 滚出屏幕。
    const scroller = el?.parentElement?.parentElement?.parentElement ?? null;
    if (el === null || scroller === null) return;
    const fit = (): void => {
      const cs = getComputedStyle(scroller);
      const available = scroller.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      el.style.height = `${Math.max(available, 0)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  /* 列表按最近更新倒序；mock 会就地改 updatedAt，所以 memo 依赖里加上 selectedId 之外的
     渲染时机意义不大，顺序漂移只在下一次刷新后校正——演示数据下可接受 */
  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  /* 没有选中项、或选中项已不在列表里（刷新后被删掉）时，回落到列表第一个 */
  useEffect(() => {
    if (sortedSessions.length === 0) return;
    if (selectedId === null || !sortedSessions.some((item) => item.id === selectedId)) {
      setSelectedId(sortedSessions[0].id);
    }
  }, [sortedSessions, selectedId]);

  const selected = sortedSessions.find((item) => item.id === selectedId) ?? null;

  const channelName = useCallback(
    (channelId: string | null): string => resolveChannelName(channels, channelId),
    [channels],
  );

  /* 流式渲染：reply 到位后定时逐拍增加已渲染字符数；组件卸载或换 reply 时清掉旧定时器 */
  const reply = pending?.reply ?? null;
  useEffect(() => {
    if (reply === null) return;
    const timer = setInterval(() => {
      setPending((current) => {
        if (current === null || current.reply === null) return current;
        return { ...current, shown: Math.min(current.shown + STREAM_CHARS_PER_TICK, current.reply.content.length) };
      });
    }, STREAM_TICK_MS);
    return () => clearInterval(timer);
  }, [reply]);

  /* 整条回复渲染完：播报一次（aria-live），随后清掉 pending——store 里的会话在
     sendChatMessage 成功时已带上这条回复（mock 就地追加 / 真实后端靠动作后的自动
     refresh('chat')），清理后同一条消息改由 store 数据完整渲染，视觉无跳变 */
  useEffect(() => {
    if (pending !== null && pending.reply !== null && pending.shown >= pending.reply.content.length) {
      announce('助手回复完成');
      setPending(null);
    }
  }, [pending, announce]);

  const send = (content: string): void => {
    if (selected === null || pending !== null) return;
    const userMessage = { role: 'user' as const, content, ts: Math.floor(Date.now() / 1000) };
    setPending({ sessionId: selected.id, userMessage, reply: null, shown: 0 });
    setFollowSignal((n) => n + 1);
    sendChatMessage(selected.id, content)
      .then((assistantReply) => {
        setPending((current) =>
          current !== null && current.sessionId === selected.id
            ? { ...current, reply: assistantReply, shown: 0 }
            : current,
        );
      })
      .catch((cause: unknown) => {
        /* 失败（含演示实现报「找不到会话」）：本地回显撤掉，列表拉回真值，原因原文进 toast */
        setPending(null);
        void refresh('chat');
        toastError(errorText(cause));
      });
  };

  const sessionPending = pending !== null && selected !== null && pending.sessionId === selected.id ? pending : null;

  return (
    <div className={styles.view} ref={rootRef}>
      {/* 演示数据横幅（强制）：接入后端后整条移除，不留开关（DESIGN.md 4.5） */}
      <p className={styles.banner}>演示数据——对话尚未接入后端</p>

      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {!loaded && loading ? (
        <div className={styles.loading}>
          <Spinner label="正在加载会话列表" />
        </div>
      ) : sortedSessions.length === 0 && loaded ? (
        /* 空态只在加载过一轮之后出现，给下一步动作，不写「暂无对话」（DESIGN.md 4.5） */
        <EmptyState
          icon="chat"
          title="还没有会话"
          description="演示数据没有提供任何会话；接入后端后，新建的会话会列在左侧。先确认至少有一个渠道可用。"
          action={{ label: '刷新会话列表', icon: 'refresh', onClick: () => void refresh('chat') }}
          secondaryAction={{
            label: '去看渠道',
            icon: 'channels',
            onClick: () => useNav.getState().setView('channels'),
          }}
        />
      ) : (
        <div className={styles.body}>
          <aside className={styles.listPane}>
            <SessionList
              sessions={sortedSessions}
              channelName={channelName}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </aside>
          <section className={styles.chatPane}>
            {selected === null ? null : (
              <>
                {selected.messages.length === 0 && sessionPending === null ? (
                  <div className={styles.emptyStream}>
                    <p className={styles.emptyTitle}>选一个渠道，说第一句话</p>
                    <p className={styles.emptyHint}>
                      在下方输入框写下第一句，Enter 发送；回复会以演示数据逐字出现。
                    </p>
                  </div>
                ) : (
                  <MessageStream session={selected} pending={sessionPending} followSignal={followSignal} />
                )}
                <Composer
                  disabled={false}
                  sending={sessionPending !== null && sessionPending.reply === null}
                  streaming={sessionPending !== null && sessionPending.reply !== null}
                  onSend={send}
                />
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
