/**
 * 命令面板（Ctrl+K）。Cursor 式中心浮层：宽 560、距顶 15vh、--bg-elevated + --shadow-lg + --radius-lg
 * （DESIGN.md 第 4.3 节）。
 *
 * 它是键盘用户的主入口，所以所有跨视图动作都必须能在这里找到：切视图、启动会话、改槽位、
 * 刷新、切主题、打开配置目录。匹配用 lib 的 fuzzyMatch 做子序列匹配，命中字符用 --accent-text 高亮。
 *
 * 改槽位天然是两步（先选槽位，再选渠道与模型），所以面板有两级：root 与 slot。
 * slot 级里 Esc 或空输入按退格回到 root，不用鼠标也能退出来。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from '../components';
import type { IconName } from '../components';
import { cx, fuzzyMatch } from '../lib';
import { openPath, revealInFolder } from '../api';
import { errorText, pickDefaultHub, useApp } from '../store';
import { useNav } from '../store/nav';
import type { ThemeMode, ViewId } from '../store/nav';
import { THEME_LABEL } from '../store/nav';
import type { HubConfig, LaunchTarget, SlotName } from '../types/contract';
import { useAnnouncer } from './announce';
import { VIEW_LIST, VIEW_META, VIEW_REFRESH_KEY, viewShortcut } from './views';
import styles from './CommandPalette.module.css';

/** 四个分组的顺序与标题（DESIGN.md 第 4.3 节） */
type PaletteGroupId = 'nav' | 'channel' | 'slot' | 'action';

const GROUP_SEQUENCE: PaletteGroupId[] = ['nav', 'channel', 'slot', 'action'];

const GROUP_TITLE: Record<PaletteGroupId, string> = {
  nav: '导航',
  channel: '渠道',
  slot: '槽位',
  action: '动作',
};

const SLOTS: SlotName[] = ['fable', 'opus', 'sonnet', 'haiku'];

const THEME_SEQUENCE: ThemeMode[] = ['system', 'dark', 'light'];

/** 每组最多显示的条数：再多就靠继续输入筛，而不是让面板长到屏幕外 */
const MAX_PER_GROUP = 8;

type PaletteAction =
  | { kind: 'run'; run(): void | Promise<void> }
  | { kind: 'enter'; mode: PaletteMode };

interface PaletteItem {
  id: string;
  group: PaletteGroupId;
  label: string;
  /** 右侧灰字：状态、快捷键或补充说明 */
  hint: string | null;
  icon: IconName;
  /** 额外可搜索文本，不显示 */
  keywords: string;
  action: PaletteAction;
}

type PaletteMode = { kind: 'root' } | { kind: 'slot'; hubName: string; slot: SlotName };

interface ScoredRow {
  item: PaletteItem;
  indices: number[];
  score: number;
}

/** 带全局下标的行，↑↓ 与 aria-activedescendant 都按这个下标走 */
interface IndexedRow extends ScoredRow {
  index: number;
}

function slotBindingText(hub: HubConfig, slot: SlotName): string {
  const binding = hub.slots[slot];
  if (!binding) return '未绑定';
  return binding.model === '' ? binding.channel : `${binding.channel} / ${binding.model}`;
}

/** 高亮命中的字符。indices 是 fuzzyMatch 给的字符下标，连续命中并成一段以少建 DOM */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const hits = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) {
      last.text += text.charAt(i);
    } else {
      runs.push({ text: text.charAt(i), hit });
    }
  }
  return (
    <>
      {runs.map((run, index) =>
        run.hit ? (
          <span key={index} className={styles.hit}>
            {run.text}
          </span>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}

export default function CommandPalette() {
  const channels = useApp((state) => state.channels);
  const hubs = useApp((state) => state.hubs);
  const env = useApp((state) => state.env);
  const refresh = useApp((state) => state.refresh);
  const refreshAll = useApp((state) => state.refreshAll);
  const setSlot = useApp((state) => state.setSlot);
  const launch = useApp((state) => state.launch);

  const view = useNav((state) => state.view);
  const setView = useNav((state) => state.setView);
  const setPaletteOpen = useNav((state) => state.setPaletteOpen);
  const toggleSidebar = useNav((state) => state.toggleSidebar);
  const sidebarCollapsed = useNav((state) => state.sidebarCollapsed);
  const theme = useNav((state) => state.theme);
  const setTheme = useNav((state) => state.setTheme);

  const announce = useAnnouncer((state) => state.announce);

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<PaletteMode>({ kind: 'root' });
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (): void => setPaletteOpen(false);

  const items = useMemo<PaletteItem[]>(() => {
    const hub = pickDefaultHub(hubs);

    const goto = (target: ViewId): void => {
      setView(target);
    };

    const runLaunch = async (target: LaunchTarget, label: string): Promise<void> => {
      try {
        const result = await launch(target);
        announce(result.ok ? `${label}：${result.message}` : `${label}未成功：${result.message}`);
      } catch (cause) {
        announce(`${label}未成功：${errorText(cause)}`);
      }
    };

    const runSetSlot = async (
      hubName: string,
      slot: SlotName,
      channel: string | null,
      model: string | null,
      label: string,
    ): Promise<void> => {
      try {
        await setSlot(hubName, slot, channel, model);
        announce(`${label}，已写入 ${hubName} 的配置`);
      } catch (cause) {
        announce(`${label}未成功：${errorText(cause)}`);
      }
    };

    const runOpen = async (path: string, label: string, reveal: boolean): Promise<void> => {
      try {
        await (reveal ? revealInFolder(path) : openPath(path));
        announce(`${label}：${path}`);
      } catch (cause) {
        announce(`${label}未成功：${errorText(cause)}`);
      }
    };

    // 二级：给某个槽位挑渠道与模型
    if (mode.kind === 'slot') {
      const target = hubs.find((candidate) => candidate.name === mode.hubName) ?? null;
      const slot = mode.slot;
      if (!target) {
        return [
          {
            id: 'slot-missing-hub',
            group: 'slot',
            label: `找不到 hub ${mode.hubName}，先去模型槽位视图确认配置`,
            hint: null,
            icon: 'warning',
            keywords: 'hub slot',
            action: { kind: 'run', run: () => goto('slots') },
          },
        ];
      }

      const rows: PaletteItem[] = [];
      for (const hubChannel of target.channels) {
        if (hubChannel.models.length === 0) {
          rows.push({
            id: `slot-${slot}-${hubChannel.name}-default`,
            group: 'slot',
            label: `把 ${slot} 槽位绑到 ${hubChannel.name}（不指定模型）`,
            hint: hubChannel.resolvedChannelId === null ? '渠道未解析' : (hubChannel.apiFormat ?? '协议未知'),
            icon: 'slots',
            keywords: `${slot} ${hubChannel.name} ${hubChannel.provider}`,
            action: {
              kind: 'run',
              run: () =>
                runSetSlot(target.name, slot, hubChannel.name, null, `${slot} 槽位绑到 ${hubChannel.name}`),
            },
          });
          continue;
        }
        for (const model of hubChannel.models) {
          rows.push({
            id: `slot-${slot}-${hubChannel.name}-${model}`,
            group: 'slot',
            label: `把 ${slot} 槽位绑到 ${hubChannel.name} 的 ${model}`,
            hint: hubChannel.resolvedChannelId === null ? '渠道未解析' : (hubChannel.apiFormat ?? '协议未知'),
            icon: 'slots',
            keywords: `${slot} ${hubChannel.name} ${hubChannel.provider} ${model}`,
            action: {
              kind: 'run',
              run: () =>
                runSetSlot(
                  target.name,
                  slot,
                  hubChannel.name,
                  model,
                  `${slot} 槽位绑到 ${hubChannel.name} 的 ${model}`,
                ),
            },
          });
        }
      }

      if (rows.length === 0) {
        rows.push({
          id: `slot-${slot}-no-channels`,
          group: 'slot',
          label: `hub ${target.name} 还没声明 channels，先去模型槽位视图添加`,
          hint: null,
          icon: 'warning',
          keywords: `${slot} channels`,
          action: { kind: 'run', run: () => goto('slots') },
        });
      }

      rows.push({
        id: `slot-${slot}-clear`,
        group: 'slot',
        label: `清除 ${slot} 槽位的绑定`,
        hint: slotBindingText(target, slot),
        icon: 'close',
        keywords: `${slot} clear 清除`,
        action: {
          kind: 'run',
          run: () => runSetSlot(target.name, slot, null, null, `${slot} 槽位绑定已清除`),
        },
      });
      return rows;
    }

    // 一级：导航 + 渠道 + 槽位 + 动作
    const rows: PaletteItem[] = [];

    for (const meta of VIEW_LIST) {
      rows.push({
        id: `nav-${meta.id}`,
        group: 'nav',
        label: `转到 ${meta.title}`,
        hint: viewShortcut(meta.id),
        icon: meta.icon,
        keywords: `${meta.navLabel} ${meta.subtitle}`,
        action: { kind: 'run', run: () => goto(meta.id) },
      });
    }

    for (const channel of channels) {
      if (channel.hidden) continue;
      const notes: string[] = [channel.apiFormat];
      if (channel.compatibility === 'incompatible') notes.push('语义不兼容');
      if (channel.credential === 'missing') notes.push('凭证未配置');
      rows.push({
        id: `channel-${channel.id}`,
        group: 'channel',
        label: `用 ${channel.name} 启动会话`,
        hint: notes.join(' · '),
        icon: 'play',
        keywords: `${channel.alias ?? ''} ${channel.endpoint ?? ''} ${channel.declaredModel ?? ''}`,
        action: {
          kind: 'run',
          run: () => runLaunch({ kind: 'channel', channelId: channel.id }, `用 ${channel.name} 启动会话`),
        },
      });
    }

    if (hub) {
      for (const slot of SLOTS) {
        rows.push({
          id: `slot-enter-${slot}`,
          group: 'slot',
          label: `设置 ${slot} 槽位`,
          hint: `${hub.name} · ${slotBindingText(hub, slot)}`,
          icon: 'slots',
          keywords: `slot 槽位 ${slot} ${hub.name}`,
          action: { kind: 'enter', mode: { kind: 'slot', hubName: hub.name, slot } },
        });
      }
    }

    rows.push({
      id: 'action-refresh-view',
      group: 'action',
      label: `刷新当前视图（${VIEW_META[view].title}）`,
      hint: 'Ctrl+R',
      icon: 'refresh',
      keywords: 'refresh 刷新',
      action: {
        kind: 'run',
        run: async () => {
          await refresh(VIEW_REFRESH_KEY[view]);
          announce(`${VIEW_META[view].title} 数据已刷新`);
        },
      },
    });

    rows.push({
      id: 'action-refresh-all',
      group: 'action',
      label: '刷新全部数据',
      hint: '渠道、hub、用量、诊断、账号池、体检',
      icon: 'refresh',
      keywords: 'refresh all 全部 刷新',
      action: {
        kind: 'run',
        run: async () => {
          await refreshAll();
          announce('全部数据已刷新');
        },
      },
    });

    rows.push({
      id: 'action-sidebar',
      group: 'action',
      label: sidebarCollapsed ? '展开侧栏' : '折叠侧栏',
      hint: 'Ctrl+B',
      icon: 'sidebar',
      keywords: 'sidebar 侧栏 折叠 展开',
      action: { kind: 'run', run: () => toggleSidebar() },
    });

    for (const candidate of THEME_SEQUENCE) {
      rows.push({
        id: `action-theme-${candidate}`,
        group: 'action',
        label: `主题：${THEME_LABEL[candidate]}`,
        hint: candidate === theme ? '当前' : null,
        icon: candidate === 'dark' ? 'moon' : candidate === 'light' ? 'sun' : 'monitor',
        keywords: `theme 主题 ${candidate}`,
        action: {
          kind: 'run',
          run: () => {
            setTheme(candidate);
            announce(`主题已切换为${THEME_LABEL[candidate]}`);
          },
        },
      });
    }

    rows.push({
      id: 'action-doctor',
      group: 'action',
      label: '运行本机体检',
      hint: '只读不联网',
      icon: 'doctor',
      keywords: 'doctor 体检 检查',
      action: {
        kind: 'run',
        run: async () => {
          goto('doctor');
          await refresh('doctor');
        },
      },
    });

    if (env) {
      rows.push({
        id: 'action-open-config',
        group: 'action',
        label: '在 Finder 中显示配置文件',
        hint: env.configPath,
        icon: 'reveal',
        keywords: 'config 配置 目录 finder',
        action: { kind: 'run', run: () => runOpen(env.configPath, '已定位配置文件', true) },
      });
      rows.push({
        id: 'action-open-logs',
        group: 'action',
        label: '打开日志目录',
        hint: env.logsDir,
        icon: 'external',
        keywords: 'log 日志 目录',
        action: { kind: 'run', run: () => runOpen(env.logsDir, '已打开日志目录', false) },
      });
    }

    if (hub) {
      rows.push({
        id: 'action-launch-hub',
        group: 'action',
        label: `启动 hub ${hub.name} 的会话`,
        hint: hub.running ? 'hub 正在运行' : 'hub 未运行',
        icon: 'terminal',
        keywords: 'hub launch 启动',
        action: {
          kind: 'run',
          run: () => runLaunch({ kind: 'hub', hubName: hub.name }, `启动 hub ${hub.name} 的会话`),
        },
      });
      for (const slot of SLOTS) {
        if (!hub.slots[slot]) continue;
        rows.push({
          id: `action-launch-slot-${slot}`,
          group: 'action',
          label: `按 ${slot} 槽位启动会话`,
          hint: slotBindingText(hub, slot),
          icon: 'play',
          keywords: `launch 启动 槽位 ${slot}`,
          action: {
            kind: 'run',
            run: () => runLaunch({ kind: 'slot', hubName: hub.name, slot }, `按 ${slot} 槽位启动会话`),
          },
        });
      }
    }

    return rows;
  }, [
    announce,
    channels,
    env,
    hubs,
    launch,
    mode,
    refresh,
    refreshAll,
    setSlot,
    setTheme,
    setView,
    sidebarCollapsed,
    theme,
    toggleSidebar,
    view,
  ]);

  const groups = useMemo(() => {
    const trimmed = query.trim();
    const out: { id: PaletteGroupId; rows: ScoredRow[]; hidden: number }[] = [];
    for (const group of GROUP_SEQUENCE) {
      const scored: ScoredRow[] = [];
      for (const item of items) {
        if (item.group !== group) continue;
        const primary = fuzzyMatch(trimmed, item.label);
        if (primary.matched) {
          scored.push({ item, indices: primary.indices, score: primary.score });
          continue;
        }
        // 标签没命中就再试一遍隐藏关键词与说明；这类命中不高亮，排序也压后
        const secondary = fuzzyMatch(trimmed, `${item.keywords} ${item.hint ?? ''}`);
        if (secondary.matched) scored.push({ item, indices: [], score: secondary.score - 100 });
      }
      if (trimmed !== '') scored.sort((a, b) => b.score - a.score);
      if (scored.length === 0) continue;
      out.push({
        id: group,
        rows: scored.slice(0, MAX_PER_GROUP),
        hidden: Math.max(0, scored.length - MAX_PER_GROUP),
      });
    }
    return out;
  }, [items, query]);

  const rendered = useMemo(() => {
    let cursor = -1;
    return groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        cursor += 1;
        return { ...row, index: cursor } satisfies IndexedRow;
      }),
    }));
  }, [groups]);

  const rows = useMemo<IndexedRow[]>(() => rendered.flatMap((group) => group.rows), [rendered]);
  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query, mode]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rendered]);

  const execute = (item: PaletteItem): void => {
    const action = item.action;
    if (action.kind === 'enter') {
      setMode(action.mode);
      setQuery('');
      inputRef.current?.focus();
      return;
    }
    close();
    // 动作自己已经把失败播报出去了；这里兜的是同步抛出这种意外情况，同样不吞
    void Promise.resolve()
      .then(() => action.run())
      .catch((cause: unknown) => announce(`命令执行未成功：${errorText(cause)}`));
  };

  const backToRoot = (): void => {
    setMode({ kind: 'root' });
    setQuery('');
    inputRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const base = activeIndex < 0 ? 0 : activeIndex;
      setActive((base + step + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) execute(row.item);
      return;
    }
    if (event.key === 'Backspace' && query === '' && mode.kind === 'slot') {
      event.preventDefault();
      backToRoot();
    }
  };

  /**
   * 面板层只管两件事：Esc 退一级 / 关面板，Tab 在浮层内循环。
   * 焦点陷阱是自己实现的：浮层是模态的，Tab 不许把焦点交给底下的界面，
   * 但也不能像「一律吞掉 Tab」那样让二级面板的返回按钮键盘不可达（DESIGN.md 第 6 节）。
   */
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (mode.kind === 'slot') backToRoot();
      else close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>('input, button');
    if (!focusable || focusable.length === 0) return;
    event.preventDefault();
    const list = Array.from(focusable);
    const current = list.indexOf(document.activeElement as HTMLElement);
    const step = event.shiftKey ? -1 : 1;
    list[(Math.max(current, 0) + step + list.length) % list.length].focus();
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={onPanelKeyDown}
      >
        <div className={styles.inputRow}>
          <Icon name="search" className={styles.searchIcon} />
          {mode.kind === 'slot' ? (
            <span className={styles.scope}>
              槽位 · {mode.slot}
              <button type="button" className={styles.scopeBack} onClick={backToRoot} aria-label="返回全部命令">
                <Icon name="close" size={12} />
              </button>
            </span>
          ) : null}
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode.kind === 'slot' ? '筛选渠道与模型' : '输入命令：切视图、启动会话、改槽位、刷新、切主题'}
            role="combobox"
            aria-expanded={true}
            aria-controls="palette-list"
            aria-activedescendant={activeIndex >= 0 ? `palette-item-${activeIndex}` : undefined}
            aria-label="命令输入"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className={styles.list} id="palette-list" role="listbox" aria-label="命令结果" ref={listRef}>
          {rows.length === 0 ? (
            <p className={styles.empty}>没有命令匹配「{query.trim()}」，换个说法再试</p>
          ) : (
            rendered.map((group) => (
              <section key={group.id} className={styles.group} role="group" aria-label={GROUP_TITLE[group.id]}>
                {/* 分组名已经由 role="group" 的 aria-label 提供，避免读屏重复念一遍 */}
                <h2 className={styles.groupTitle} aria-hidden="true">
                  {GROUP_TITLE[group.id]}
                </h2>
                {group.rows.map((row) => {
                  const index = row.index;
                  const selected = index === activeIndex;
                  return (
                    <div
                      key={row.item.id}
                      id={`palette-item-${index}`}
                      role="option"
                      aria-selected={selected}
                      data-active={selected ? 'true' : 'false'}
                      className={cx(styles.row, selected && styles.rowActive)}
                      onMouseMove={() => setActive(index)}
                      onClick={() => execute(row.item)}
                    >
                      <Icon name={row.item.icon} className={styles.rowIcon} />
                      <span className={styles.rowLabel}>
                        <Highlighted text={row.item.label} indices={row.indices} />
                      </span>
                      {row.item.hint === null ? null : <span className={styles.rowHint}>{row.item.hint}</span>}
                    </div>
                  );
                })}
                {group.hidden > 0 ? (
                  <p className={styles.more}>还有 {group.hidden} 条未显示，继续输入以筛选</p>
                ) : null}
              </section>
            ))
          )}
        </div>

        <div className={styles.legend}>
          <span>↑↓ 移动</span>
          <span>Enter 执行</span>
          <span>{mode.kind === 'slot' ? 'Esc 返回' : 'Esc 关闭'}</span>
        </div>
      </div>
    </div>
  );
}
