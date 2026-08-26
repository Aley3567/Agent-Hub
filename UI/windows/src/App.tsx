/**
 * 布局骨架（DESIGN.md 第 3 节）：TitleBar / Sidebar / 主内容区（ViewHeader + 视图）/ StatusBar。
 *
 * 三条硬约束：
 *   1. 主内容区里的 .scroll 是唯一滚动容器，body 永不横向滚动；
 *   2. 内容最大宽 --content-max-w(1120) 居中，表格类视图按元数据的 fullWidth 满宽；
 *   3. 视图按 CONTRACT.md 第 6.1 节的固定路由表 lazy 加载，Suspense 兜底是顶部 1px accent
 *      进度线，不用骨架屏（DESIGN.md 第 2.5 节）。
 */
import { Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import type { ComponentType } from 'react';
import { Button } from './components';
import { cx } from './lib';
import { useApp } from './store';
import { useNav } from './store/nav';
import type { ViewId } from './store/nav';
import CommandPalette from './shell/CommandPalette';
import RouteProgress from './shell/RouteProgress';
import Sidebar from './shell/Sidebar';
import StatusBar from './shell/StatusBar';
import TitleBar from './shell/TitleBar';
import ToastLayer from './shell/ToastLayer';
import ViewHeader from './shell/ViewHeader';
import { useAnnouncer } from './shell/announce';
import { useGlobalKeyboard } from './shell/keyboard';
import { VIEWS, VIEW_META, VIEW_REFRESH_KEY, refreshView } from './shell/views';
import styles from './App.module.css';

/** 路由表的键与路径由 CONTRACT.md 第 6.1 节写死，这里只是把它们包成 lazy 组件 */
const LAZY_VIEWS = {
  chat: lazy(VIEWS.chat),
  channels: lazy(VIEWS.channels),
  slots: lazy(VIEWS.slots),
  usage: lazy(VIEWS.usage),
  diagnostics: lazy(VIEWS.diagnostics),
  accounts: lazy(VIEWS.accounts),
  doctor: lazy(VIEWS.doctor),
  plugins: lazy(VIEWS.plugins),
  tasks: lazy(VIEWS.tasks),
  settings: lazy(VIEWS.settings),
} satisfies Record<ViewId, ComponentType>;

export default function App() {
  const view = useNav((state) => state.view);
  const paletteOpen = useNav((state) => state.paletteOpen);

  const refreshAll = useApp((state) => state.refreshAll);
  const busy = useApp((state) => VIEW_REFRESH_KEY[view].some((key) => state.loading[key] === true));
  const channelCount = useApp((state) => state.channels.length);
  const hubCount = useApp((state) => state.hubs.length);
  const poolCount = useApp((state) => state.pools.length);
  const errorCount = useApp((state) => state.errors.length);
  const doctorChecks = useApp((state) => state.doctor);
  const chatSessionCount = useApp((state) => state.chatSessions.length);
  const pluginCount = useApp((state) => state.plugins.length);
  const taskCount = useApp((state) => state.tasks.length);
  const turns = useApp((state) => state.usage?.totals.turns ?? null);

  const announce = useAnnouncer((state) => state.announce);
  const bootstrapped = useRef(false);

  useGlobalKeyboard();

  useEffect(() => {
    // StrictMode 在开发期会重挂一次，这个闸门保证首屏只拉一遍数据
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (doctorChecks.length === 0) return;
    const failed = doctorChecks.filter((check) => check.level === 'fail').length;
    const noticed = doctorChecks.filter((check) => check.level === 'info').length;
    announce(
      failed === 0 && noticed === 0
        ? `体检完成：${doctorChecks.length} 项全部通过`
        : `体检完成：共 ${doctorChecks.length} 项，失败 ${failed} 项，提醒 ${noticed} 项`,
    );
  }, [announce, doctorChecks]);

  const countText = useMemo<string | null>(() => {
    switch (view) {
      case 'chat':
        return `${chatSessionCount} 个会话`;
      case 'channels':
        return `${channelCount} 个渠道`;
      case 'slots':
        return `${hubCount} 个 hub`;
      case 'usage':
        return turns === null ? null : `${turns} 个回合`;
      case 'diagnostics':
        return `${errorCount} 条错误`;
      case 'accounts':
        return `${poolCount} 个账号池`;
      case 'doctor':
        return `${doctorChecks.length} 项检查`;
      case 'plugins':
        return `${pluginCount} 个插件`;
      case 'tasks':
        return `${taskCount} 个任务`;
      case 'settings':
        return null;
    }
  }, [channelCount, chatSessionCount, doctorChecks.length, errorCount, hubCount, pluginCount, poolCount, taskCount, turns, view]);

  const meta = VIEW_META[view];
  const CurrentView = LAZY_VIEWS[view];

  return (
    // view-enter + firstPaint：整层壳只挂载一次，所以这里就是「首屏内容浮现」，走 --dur-slow
    <div className={cx(styles.app, 'view-enter', styles.firstPaint)}>
      <TitleBar />
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>
          <ViewHeader
            view={view}
            count={countText}
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                loading={busy}
                onClick={() => void refreshView(view)}
                title="刷新本视图数据 Ctrl+R"
              >
                刷新
              </Button>
            }
          />
          <div className={styles.scroll}>
            <div className={cx(styles.container, meta.fullWidth && styles.fullWidth)}>
              <Suspense fallback={<RouteProgress />}>
                {/* 视图切换入场：styles/global.css 的 view-enter（opacity + 2px 上移，
                    自带 --dur-normal，DESIGN.md 第 2.5 节关键帧清单里那一个）。
                    两个细节是刻意的：
                      · key={view} —— 不换 key 的话 React 复用同一个 DOM 节点，动画不会重播；
                      · 这层放在 Suspense 内侧 —— 兜底期间 children 根本不挂载，
                        所以动画等 lazy chunk 落地、内容真的到位那一刻才开始，
                        不会在顶部进度线还在跑的时候空转一遍。 */}
                <div key={view} className="view-enter">
                  <CurrentView />
                </div>
              </Suspense>
            </div>
          </div>
        </main>
      </div>
      <StatusBar />
      {paletteOpen ? <CommandPalette /> : null}
      {/* toast 渲染层常驻（空队列时自身返回 null），层级 --z-toast，在命令面板之上 */}
      <ToastLayer />
    </div>
  );
}
