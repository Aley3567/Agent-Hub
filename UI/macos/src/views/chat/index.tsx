/**
 * 对话视图（ViewId chat，DESIGN.md 4.5）：会话列表 + 消息流 + composer 的工作台三件套。
 *
 * 两类会话在同一份数据里（ChatSession.source）：
 *   · history —— `~/.claude/projects/<project_key>/*.jsonl` 的只读回放，顶部项目选择器决定
 *     回放哪个项目；发送路径对它是硬拒绝（send 直接早退，不只是把按钮置灰）；
 *   · local —— 可写、可真发送：经 hub 的 POST /v1/messages 打到渠道上游，正文由 chat-stream
 *     事件逐段到达（shell/chatEvents.ts），本视图只渲染 store 的 chatStream.text——
 *     这里不再有自己的流式节奏（原先那个逐字补字的定时器已删）。
 *
 * 本视图满宽且自身接管滚动——会话列表与消息流是两个独立滚动容器，壳层内容区不滚，
 * 是「唯一滚动容器」（DESIGN.md 3 节）的唯一视图级例外。落地方式：壳层的滚动容器
 * （App.module.css 的 .scroll）高度由壳层自己定，这里用 ResizeObserver 量出它的可视高，
 * 减去它的上下 padding 后写成本视图的固定高——内容高度与可视高相等，壳层就没有东西可滚，
 * 滚动只发生在两个栏各自内部。用测量而不用 calc(100vh - …) 是因为 ViewHeader 的高度
 * 不是 token，写死会在壳层改版或界面缩放（body zoom）时漂移。
 *
 * 数据纪律：
 *   · 会话与消息只走 useApp 的 chatSessions / chatStream / sendChatMessage，视图不造会话数据；
 *   · 本地回显（pending）只在真值里还没有这条用户消息时显示，真值一到就退场，中间不跳变；
 *   · sendChatMessage 失败：已经由事件通道交代过的（chat-stream-error 的原文、truncated 的
 *     system 说明）不重复报，没有兜底的失败（历史会话、找不到会话）才由这里 toast 并拉回真值；
 *   · aria-live 播报只在整条回复结束时做一次（在 chatEvents 里），不逐字播报（DESIGN.md 4.5）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, EmptyState, Spinner } from '../../components';
import { bilingual as b, t } from '../../i18n';
import { errorText, pickDefaultHub, useApp } from '../../store';
import { useNav } from '../../store/nav';
import { useToast } from '../../store/toast';
import type { ChatMessage, ChatSession } from '../../types/contract';
import Composer from './parts/Composer';
import MessageStream, { sameMessage, type PendingSend } from './parts/MessageStream';
import NewSessionDialog from './parts/NewSessionDialog';
import ProjectPicker from './parts/ProjectPicker';
import SessionList, { resolveChannelName } from './parts/SessionList';
import styles from './index.module.css';

export default function ChatView() {
  const sessions = useApp((state) => state.chatSessions);
  const projects = useApp((state) => state.chatProjects);
  const channels = useApp((state) => state.channels);
  const hubs = useApp((state) => state.hubs);
  const stream = useApp((state) => state.chatStream);
  const offline = useApp((state) => state.offline);
  const loading = useApp((state) => state.loading.chat === true);
  const projectsLoading = useApp((state) => state.loading.chatProjects === true);
  const loaded = useApp((state) => state.loadedKeys.chat === true);
  const projectsLoaded = useApp((state) => state.loadedKeys.chatProjects === true);
  const hubsLoaded = useApp((state) => state.loadedKeys.hubs === true);
  const reason = useApp((state) => state.error.chat ?? null);
  const refresh = useApp((state) => state.refresh);
  const sendChatMessage = useApp((state) => state.sendChatMessage);
  const deleteChatSession = useApp((state) => state.deleteChatSession);
  const registerViewReload = useNav((state) => state.registerViewReload);
  const toastError = useToast((state) => state.error);
  const toastSuccess = useToast((state) => state.success);

  const rootRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [followSignal, setFollowSignal] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ChatSession | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  /* 重试：列表、历史项目、hub 运行状态三份一起拉回来——hub 起来之后这一步就能解锁发送 */
  const retry = useCallback((): void => {
    void refresh('chat');
    void refresh('chatProjects');
    void refresh('hubs');
  }, [refresh]);

  /* 视图刷新注册：壳层 ⌘R / 刷新按钮转发到这里；卸载时必须传 null 注销（CONTRACT.md 6.2） */
  useEffect(() => {
    registerViewReload('chat', retry);
    return () => registerViewReload('chat', null);
  }, [registerViewReload, retry]);

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

  /* 列表按最近更新倒序 */
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

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

  /* 当前回放的项目：Rust 只回放选中项目的历史，所以从列表里的历史会话反推。
     接口没回传当前选中项，列表为空时反推不出来，选择器就显示未选中。 */
  const activeProject = useMemo(
    () => sessions.find((item) => item.source === 'history')?.projectKey ?? null,
    [sessions],
  );

  /* 选中会话实际要走的 hub：本地会话认自己绑的（null = 默认 hub），历史会话只读，用默认的 */
  const boundHub = useMemo(() => {
    if (selected !== null && selected.hubName !== null) {
      return hubs.find((hub) => hub.name === selected.hubName) ?? null;
    }
    return pickDefaultHub(hubs);
  }, [hubs, selected]);

  /* hub 不在跑 = 新建与发送一定失败。提前如实说清，并给重试与启动办法（不写「暂无对话」） */
  const hubDown = !offline && hubsLoaded && boundHub !== null && !boundHub.running;

  /* 选中会话在途的流与本地回显：都属于这条会话才渲染，其他会话的与这一栏无关 */
  const sessionStream = stream !== null && selected !== null && stream.sessionId === selected.id ? stream.text : null;
  const sessionPending = pending !== null && selected !== null && pending.sessionId === selected.id ? pending : null;

  /* 本地回显退场：真值里已经有这条用户消息（Rust 在开流前就落盘了），就交给 store 渲染 */
  useEffect(() => {
    if (pending === null) return;
    const session = sessions.find((item) => item.id === pending.sessionId);
    if (session !== undefined && session.messages.some((message) => sameMessage(message, pending.userMessage))) {
      setPending(null);
    }
  }, [sessions, pending]);

  const send = (content: string): void => {
    // 历史会话只读：函数本身拒绝，按钮置灰只是提示，不是唯一防线
    if (selected === null || selected.source === 'history') return;
    // 这条会话上已经有一轮真实流在跑：等它说完
    if (sessionStream !== null) return;
    const sessionId = selected.id;
    const userMessage: ChatMessage = { role: 'user', content, ts: Math.floor(Date.now() / 1000) };
    setPending({ sessionId, userMessage });
    setFollowSignal((n) => n + 1);
    sendChatMessage(sessionId, content).catch((cause: unknown) => {
      // 事件通道已经为这次尝试交代过（错误原文已 toast、截断说明已落盘成 system 消息）
      // 就只对账，不重复报；没有兜底的失败（历史会话、找不到会话）才由这里报
      const reported = useApp.getState().chatStreamTerminal?.sessionId === sessionId;
      // 命令回执这条通道拿不到 requestId（它只在事件里），传空串 = 「这次尝试还没被认领
      // 的失败」，守卫按 appendChatDelta 同一套口径放行；错误事件那条通道带真 requestId，
      // 对不上在途流的一律作废。返回值在这里不用：reported 与否都要对账。
      useApp.getState().failChatStream({ sessionId, requestId: '', message: errorText(cause) });
      if (!reported) {
        setPending(null);
        toastError(errorText(cause));
      }
      void refresh('chat');
    });
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return;
    setDeleteBusy(true);
    try {
      await deleteChatSession(deleting.id);
      if (selectedId === deleting.id) setSelectedId(null);
      toastSuccess(b(t("已删除会话「{0}」。", [deleting.title]), `Deleted session “${deleting.title}”.`));
      setDeleting(null);
    } catch (cause) {
      // IPC 的中文错误原文直接给 toast，不改写（AGENTS.md：错误原样暴露）
      toastError(errorText(cause));
    } finally {
      setDeleteBusy(false);
    }
  };

  /* 空态分三种口径：没有桌面后端 / hub 没在跑 / 真的一个会话都没有。
     三种都给下一步动作——「暂无会话」是禁语（DESIGN.md 4.5）。 */
  const emptyState = offline ? (
    <EmptyState
      icon="chat"
      title={t('没有检测到桌面后端')}
      description={t('浏览器预览里没有真实会话：历史回放与发送都要读写本机文件，只有桌面应用能做。请从 Agent Hub 桌面应用打开这个视图。')}
      action={{ label: t('重试'), icon: 'refresh', onClick: retry }}
    />
  ) : hubDown ? (
    <EmptyState
      icon="chat"
      title={t('claude-hub 未在运行')}
      description={t('发送要经 hub 转发到渠道，hub 没在跑时新建会话与发送都会失败；历史回放读的是本机 jsonl，不受影响。')}
      action={{ label: t('重试'), icon: 'refresh', onClick: retry }}
      secondaryAction={{ label: t('去看槽位'), icon: 'slots', onClick: () => useNav.getState().setView('slots') }}
      hint={t('怎么启动：在「槽位」页对目标 hub 点一次启动，它会在新终端里起一个会话并把 hub 拉起来。')}
    />
  ) : (
    <EmptyState
      icon="chat"
      title={t('还没有会话')}
      description={
        /* 项目列表还没读回来时不下「没有历史项目」的结论（空态文案也是一种结论） */
        projectsLoaded && projects.length === 0
          ? t('本机没有找到可回放的历史项目（~/.claude/projects 下没有会话文件）；要真发消息，就新建一个本地会话。')
          : t('历史回放跟着顶部选中的项目走，换项目就换一批；要真发消息，得新建一个绑定了渠道的本地会话。')
      }
      action={{
        label: t('新建会话'),
        icon: 'plus',
        variant: 'primary',
        onClick: () => setCreating(true),
        disabled: offline,
      }}
      secondaryAction={{ label: t('去看渠道'), icon: 'channels', onClick: () => useNav.getState().setView('channels') }}
    />
  );

  return (
    <div className={styles.view} ref={rootRef}>
      <div className={styles.toolbar}>
        <ProjectPicker
          className={styles.toolbarPicker}
          projects={projects}
          selectedKey={activeProject}
          loading={!projectsLoaded && projectsLoading}
        />
        <Button variant="primary" size="sm" icon="plus" disabled={offline} onClick={() => setCreating(true)}>
          {t('新建会话')}
        </Button>
      </div>

      {/* hub 没在跑：在还有会话可看的时候也说出来，不然失败的只有发送那一下 */}
      {hubDown && sortedSessions.length > 0 ? (
        <div className={styles.notice} role="status">
          <span className={styles.noticeText}>
            {t('claude-hub 未在运行：新建会话与发送都会失败，历史回放不受影响。去「槽位」页启动一次 hub，再回来重试。')}
          </span>
          <Button variant="secondary" size="sm" icon="refresh" onClick={retry}>
            {t('重试')}
          </Button>
        </div>
      ) : null}

      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {!loaded && loading ? (
        <div className={styles.loading}>
          <Spinner label={t('正在加载会话列表')} />
        </div>
      ) : sortedSessions.length === 0 && loaded ? (
        emptyState
      ) : (
        <div className={styles.body}>
          <aside className={styles.listPane}>
            <SessionList
              sessions={sortedSessions}
              channelName={channelName}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDelete={setDeleting}
            />
          </aside>
          <section className={styles.chatPane}>
            {selected === null ? null : (
              <>
                {selected.messages.length === 0 && sessionPending === null && sessionStream === null ? (
                  <div className={styles.emptyStream}>
                    <p className={styles.emptyTitle}>{t('说第一句话')}</p>
                    <p className={styles.emptyHint}>
                      {selected.source === 'history'
                        ? t('这个历史会话里没有可回放的消息，换一个会话或换一个项目看看。')
                        : t('在下方输入框写下第一句，Enter 发送；回复经 hub 真连这个会话绑定的渠道。')}
                    </p>
                  </div>
                ) : (
                  <MessageStream
                    session={selected}
                    stream={sessionStream}
                    pending={sessionPending}
                    followSignal={followSignal}
                  />
                )}
                {/* 历史回放只读：整体禁用（DESIGN.md 4.5）；readOnly 只决定文案怎么说 */}
                <Composer
                  disabled={selected.source === 'history'}
                  readOnly={selected.source === 'history'}
                  sending={sessionStream === ''}
                  streaming={sessionStream !== null && sessionStream !== ''}
                  onSend={send}
                />
              </>
            )}
          </section>
        </div>
      )}

      <NewSessionDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(session) => {
          setSelectedId(session.id);
          setCreating(false);
        }}
      />

      {/* 删除不可逆，先确认再执行（DESIGN.md 4.7：删除前走 Dialog 确认） */}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('删除会话')}
        description={deleting === null ? undefined : b(t("「{0}」会被删除，这个操作不可撤销。历史会话只读，删不掉。", [deleting.title]), `Delete “${deleting.title}”? This cannot be undone. History sessions are read-only.`)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleting(null)} disabled={deleteBusy}>
              {t('取消')}
            </Button>
            <Button variant="danger" size="sm" icon="trash" loading={deleteBusy} onClick={() => void confirmDelete()}>
              {t('确认删除')}
            </Button>
          </>
        }
      />
    </div>
  );
}
