import { t } from '../i18n';
/**
 * 命令面板（⌘K）。Cursor 式中心浮层：宽 560、距顶 15vh、--bg-elevated + --shadow-lg + --radius-lg
 * （DESIGN.md 第 4.3 节）。
 *
 * 它是键盘用户的主入口，所以所有跨视图动作都必须能在这里找到：切视图、启动会话、改槽位、
 * 管理渠道（隐藏 / 别名 / 模型与 effort 覆盖）、刷新、切主题、切用量时间窗、打开配置目录。
 * 匹配用 lib 的 fuzzyMatch 做子序列匹配，命中字符用 --accent-text 高亮。
 *
 * 改槽位与管渠道天然是两步（先选目标，再选要改成什么），所以面板有两级：root 与 slot / channel。
 * 二级里 Esc 或空输入按退格回到 root，不用鼠标也能退出来。channel 级里别名与模型覆盖是自由文本，
 * 直接用上方输入框的文字当新值（在条目上回显），Enter 即写入，不为它自造第二个输入框。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from '../components';
import type { IconName } from '../components';
import { cx, formatRelative, formatTime, fuzzyMatch, redactSecrets } from '../lib';
import { REFRESH_KEYS, errorText, pickDefaultHub, useApp } from '../store';
import type { RefreshKey } from '../store';
import { useNav } from '../store/nav';
import type { ThemeMode, ViewId } from '../store/nav';
import { THEME_LABEL } from '../store/nav';
import { useToast } from '../store/toast';
import { DENSITY_LABEL, useUi } from '../store/ui';
import type { Density } from '../store/ui';
import type { Channel, Effort, HubConfig, LaunchTarget, SlotName } from '../types/contract';
import { EFFORT_CHOICES } from '../views/channels/model';
import { EFFORT_UNSET, SLOT_DEFAULT_EFFORT, effortChoices, fromEffortChoice, toEffortChoice } from '../views/slots/slotModel';
import { PRESET_GRANULARITY, PRESET_LABEL, matchPreset, rangeFor } from '../views/usage/parts/range';
import type { RangePreset } from '../views/usage/parts/range';
import { useAnnouncer } from './announce';
import { VIEW_LIST, VIEW_META, VIEW_REFRESH_KEY, refreshView, viewShortcut } from './views';
import styles from './CommandPalette.module.css';

/** 五个分组的顺序与标题（DESIGN.md 第 4.3 节；「最近使用」是 REDESIGN-PROMPT 第 2.3 节补的） */
type PaletteGroupId = 'nav' | 'recent' | 'channel' | 'slot' | 'action';

const GROUP_SEQUENCE: PaletteGroupId[] = ['nav', 'recent', 'channel', 'slot', 'action'];

const GROUP_TITLE: Record<PaletteGroupId, string> = {
  get nav() { return t("导航"); },
  get recent() { return t("最近使用"); },
  get channel() { return t("渠道"); },
  get slot() { return t("槽位"); },
  get action() { return t("动作"); },
};

const SLOTS: SlotName[] = ['fable', 'opus', 'sonnet', 'haiku'];

const THEME_SEQUENCE: ThemeMode[] = ['system', 'dark', 'light'];

/** 界面大小三档，与设置页「外观」同一组取值（store/ui.ts） */
const DENSITY_SEQUENCE: Density[] = ['standard', 'large', 'larger'];

/** 「最近使用」分组的上限：按 Channel.lastUsedAt 倒序取前 5 条 */
const MAX_RECENT = 5;

/** 复制进诊断报告的错误流水条数上限：报告是摘要，不是整条 journal 的搬运 */
const REPORT_ERROR_LIMIT = 20;

/** 每组最多显示的条数：再多就靠继续输入筛，而不是让面板长到屏幕外。
 *  导航组有全部十视图，上限必须 ≥ VIEW_LIST 长度，否则「转到 任务」「转到 设置」
 *  这类尾部的视图只剩「还有 N 条未显示」提示（7 视图时代的 8 就是这么过期的）。 */
const MAX_PER_GROUP = 12;

/** refresh key 的人话名字：刷新播报失败时要说清是哪一路失败 */
const REFRESH_KEY_LABEL: Record<RefreshKey, string> = {
  get env() { return t("环境信息"); },
  get channels() { return t("渠道"); },
  get hubs() { return t("hub 配置"); },
  get pools() { return t("账号池"); },
  get usage() { return t("用量"); },
  get errors() { return t("错误流水"); },
  get doctor() { return t("体检"); },
  get chat() { return t("对话"); },
  get chatProjects() { return t("历史项目"); },
  get plugins() { return t("插件"); },
  get tasks() { return t("计划任务"); },
};

/** 用量时间窗的三个预设，与用量视图工具栏的 SegmentedControl 同一口径 */
const RANGE_PRESETS: readonly RangePreset[] = ['today', 'week', 'month'];

const GRANULARITY_LABEL: Record<'hour' | 'day', string> = { get hour() { return t("按小时"); }, get day() { return t("按天"); } };

/**
 * 刷新播报说真话：refresh 永不抛出，await 之后读 error[key]，非 null 就是失败，
 * 把失败 key 与其原因原文都念出来（AGENTS.md：错误原样暴露、绝不伪装）。
 */
function refreshProblems(keys: RefreshKey[]): string[] {
  const errors = useApp.getState().error;
  return keys
    .filter((key) => errors[key] != null)
    .map((key) => `${REFRESH_KEY_LABEL[key]}：${errors[key]}`);
}

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

type PaletteMode =
  | { kind: 'root' }
  | { kind: 'slot'; hubName: string; slot: SlotName }
  | { kind: 'channel'; channelId: string; appType: Channel['appType'] };

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
  if (!binding) return t("未绑定");
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
  const setSlotEffort = useApp((state) => state.setSlotEffort);
  const setHidden = useApp((state) => state.setHidden);
  const setAlias = useApp((state) => state.setAlias);
  const setOverride = useApp((state) => state.setOverride);
  const launch = useApp((state) => state.launch);
  const openPath = useApp((state) => state.openPath);
  const revealInFolder = useApp((state) => state.revealInFolder);
  const usageRange = useApp((state) => state.usageRange);
  const setUsageRange = useApp((state) => state.setUsageRange);

  const density = useUi((state) => state.density);
  const setDensity = useUi((state) => state.setDensity);

  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);

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
        announce(result.ok ? `${label}：${result.message}` : t("{0}未成功：{1}", [label, result.message]));
      } catch (cause) {
        announce(t("{0}未成功：{1}", [label, errorText(cause)]));
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
        announce(t("{0}，已写入 {1} 的配置", [label, hubName]));
      } catch (cause) {
        announce(t("{0}未成功：{1}", [label, errorText(cause)]));
      }
    };

    const runSetSlotEffort = async (
      hubName: string,
      slot: SlotName,
      effort: Effort | null,
      label: string,
    ): Promise<void> => {
      try {
        await setSlotEffort(hubName, slot, effort);
        announce(t("{0}，已写入 {1} 的配置", [label, hubName]));
      } catch (cause) {
        announce(t("{0}未成功：{1}", [label, errorText(cause)]));
      }
    };

    /** 渠道的隐藏 / 别名 / 覆盖都写 claude1-config.json（CONTRACT.md 第 3 节），成败播报走同一套 */
    const runChannelWrite = async (call: () => Promise<void>, label: string): Promise<void> => {
      try {
        await call();
        announce(t("{0}，已写入 claude1-config.json", [label]));
      } catch (cause) {
        announce(t("{0}未成功：{1}", [label, errorText(cause)]));
      }
    };

    const runOpen = async (path: string, label: string, reveal: boolean): Promise<void> => {
      try {
        await (reveal ? revealInFolder(path) : openPath(path));
        announce(`${label}：${path}`);
      } catch (cause) {
        announce(t("{0}未成功：{1}", [label, errorText(cause)]));
      }
    };

    /**
     * 复制诊断报告（REDESIGN-PROMPT 第 2.3 节）：体检结论 + 最近错误摘要组装成纯文本进剪贴板。
     * 整段文本必须过 redactSecrets——detail 与 message 是自由文本，fail-closed 不赌上游干净
     * （CONTRACT.md 第 1.2 节）。成败反馈走 toast（复制类操作的统一通道）+ announce 播报。
     */
    const runCopyDiagnostics = async (): Promise<void> => {
      const state = useApp.getState();
      const failed = state.doctor.filter((check) => check.level === 'fail').length;
      const noticed = state.doctor.filter((check) => check.level === 'info').length;
      const lines: string[] = [
        t("Agent Hub 诊断报告（{0}）", [formatTime(Math.floor(Date.now() / 1000))]),
        t("体检：共 {0} 项，失败 {1} 项，提醒 {2} 项", [state.doctor.length, failed, noticed]),
      ];
      for (const check of state.doctor) {
        lines.push(`- [${check.level}] ${check.title}${check.detail === null ? '' : `：${check.detail}`}`);
      }
      lines.push(t("最近错误：{0} 条", [state.errors.length]));
      for (const row of state.errors.slice(0, REPORT_ERROR_LIMIT)) {
        const parts = [
          formatTime(row.ts),
          row.phase,
          row.status === null ? null : `HTTP ${row.status}`,
          row.code,
          row.message,
        ].filter((part): part is string => part !== null);
        lines.push(`- ${parts.join(' ')}`);
      }
      try {
        await navigator.clipboard.writeText(redactSecrets(lines.join('\n')));
        toastSuccess(t("诊断报告已复制到剪贴板"));
        announce(t("诊断报告已复制到剪贴板"));
      } catch (cause) {
        toastError(t("复制诊断报告未成功：{0}", [errorText(cause)]));
        announce(t("复制诊断报告未成功：{0}", [errorText(cause)]));
      }
    };

    // 二级：管理某个渠道——启动、隐藏、别名、模型与 effort 覆盖。
    // 别名与模型覆盖是自由文本，直接用上方输入框的文字当新值（条目上回显），Enter 写入；
    // 隐藏渠道也完整列在这里，别名与 id 仍然能启动（CONTRACT.md），不许过滤掉。
    if (mode.kind === 'channel') {
      const channel = channels.find((candidate) => candidate.id === mode.channelId && candidate.appType === mode.appType) ?? null;
      if (!channel) {
        return [
          {
            id: 'channel-missing',
            group: 'channel',
            label: t("找不到这个渠道，先去渠道视图确认配置"),
            hint: null,
            icon: 'warning',
            keywords: t("channel 渠道"),
            action: { kind: 'run', run: () => goto('channels') },
          },
        ];
      }

      const typed = query.trim();
      const rows: PaletteItem[] = [];

      const notes: string[] = [channel.apiFormat];
      if (channel.hidden) notes.push(t("已隐藏"));
      if (channel.compatibility === 'incompatible') notes.push(t("语义不兼容"));
      if (channel.credential === 'missing') notes.push(t("凭证未配置"));
      rows.push({
        id: `channel-${channel.appType}:${channel.id}-launch`,
        group: 'channel',
        label: t("用 {0} 启动会话", [channel.name]),
        hint: notes.join(' · '),
        icon: 'play',
        keywords: t("{0} launch 启动", [channel.alias ?? '']),
        action: {
          kind: 'run',
          run: () => runLaunch({ kind: 'channel', channelId: channel.id, appType: channel.appType }, t("用 {0} 启动会话", [channel.name])),
        },
      });

      if (channel.appType !== 'claude') return rows;
      rows.push({
        id: `channel-${channel.appType}:${channel.id}-hidden`,
        group: 'channel',
        label: channel.hidden ? t("取消隐藏渠道 {0}", [channel.name]) : t("隐藏渠道 {0}", [channel.name]),
        hint: t("隐藏后列表默认不显示，别名与 id 仍能启动"),
        icon: channel.hidden ? 'eye' : 'eye-off',
        keywords: t("hidden 隐藏 取消隐藏 显示"),
        action: {
          kind: 'run',
          run: () =>
            runChannelWrite(
              () => setHidden(channel.id, !channel.hidden),
              channel.hidden ? t("取消隐藏渠道 {0}", [channel.name]) : t("隐藏渠道 {0}", [channel.name]),
            ),
        },
      });

      if (typed !== '' && typed !== (channel.alias ?? '')) {
        rows.push({
          id: `channel-${channel.appType}:${channel.id}-alias-set`,
          group: 'channel',
          label: t("把 {0} 的别名设为「{1}」", [channel.name, typed]),
          hint: channel.alias === null ? t("当前未设置别名") : t("当前别名：{0}", [channel.alias]),
          icon: 'edit',
          keywords: t("alias 别名"),
          action: {
            kind: 'run',
            run: () => runChannelWrite(() => setAlias(channel.id, typed), t("把 {0} 的别名设为「{1}」", [channel.name, typed])),
          },
        });
      }
      if (channel.alias !== null) {
        rows.push({
          id: `channel-${channel.appType}:${channel.id}-alias-clear`,
          group: 'channel',
          label: t("清除 {0} 的别名", [channel.name]),
          hint: t("当前别名：{0}", [channel.alias]),
          icon: 'close',
          keywords: t("alias 别名 清除"),
          action: {
            kind: 'run',
            run: () => runChannelWrite(() => setAlias(channel.id, null), t("清除 {0} 的别名", [channel.name])),
          },
        });
      }

      if (typed !== '' && typed !== (channel.modelOverride ?? '')) {
        rows.push({
          id: `channel-${channel.appType}:${channel.id}-model-set`,
          group: 'channel',
          label: t("把 {0} 的模型覆盖设为「{1}」", [channel.name, typed]),
          hint: channel.modelOverride === null ? t("当前未覆盖模型") : t("当前覆盖：{0}", [channel.modelOverride]),
          icon: 'edit',
          keywords: t("override 模型 覆盖 model"),
          action: {
            kind: 'run',
            run: () =>
              runChannelWrite(
                () => setOverride(channel.id, typed, channel.effortOverride),
                t("把 {0} 的模型覆盖设为「{1}」", [channel.name, typed]),
              ),
          },
        });
      }
      if (channel.modelOverride !== null) {
        rows.push({
          id: `channel-${channel.appType}:${channel.id}-model-clear`,
          group: 'channel',
          label: t("清除 {0} 的模型覆盖", [channel.name]),
          hint: t("当前覆盖：{0}", [channel.modelOverride]),
          icon: 'close',
          keywords: t("override 模型 覆盖 清除 model"),
          action: {
            kind: 'run',
            run: () =>
              runChannelWrite(
                () => setOverride(channel.id, null, channel.effortOverride),
                t("清除 {0} 的模型覆盖", [channel.name]),
              ),
          },
        });
      }

      // 模型与 effort 由同一个 IPC 一起写，改 effort 时必须带上现有模型覆盖，免得顺手清空
      const currentEffort = toEffortChoice(channel.effortOverride);
      for (const choice of EFFORT_CHOICES) {
        const isCurrent = currentEffort === choice.value;
        const label =
          choice.value === 'none'
            ? t("清除 {0} 的 effort 覆盖", [channel.name])
            : t("把 {0} 的 effort 覆盖设为 {1}", [channel.name, choice.label]);
        rows.push({
          id: `channel-${channel.appType}:${channel.id}-effort-${choice.value}`,
          group: 'channel',
          label,
          hint: isCurrent ? t("当前 · {0}", [choice.title]) : choice.title,
          icon: 'zap',
          keywords: t("effort 覆盖 {0}", [choice.label]),
          action: {
            kind: 'run',
            run: () =>
              runChannelWrite(
                () => setOverride(channel.id, channel.modelOverride, choice.value === 'none' ? null : choice.value),
                label,
              ),
          },
        });
      }
      return rows;
    }

    // 二级：给某个槽位挑渠道与模型
    if (mode.kind === 'slot') {
      const target = hubs.find((candidate) => candidate.name === mode.hubName) ?? null;
      const slot = mode.slot;
      if (!target) {
        return [
          {
            id: 'slot-missing-hub',
            group: 'slot',
            label: t("找不到 hub {0}，先去模型槽位视图确认配置", [mode.hubName]),
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
            label: t("把 {0} 槽位绑到 {1}（不指定模型）", [slot, hubChannel.name]),
            hint: hubChannel.resolvedChannelId === null ? t("渠道未解析") : (hubChannel.apiFormat ?? t("协议未知")),
            icon: 'slots',
            keywords: `${slot} ${hubChannel.name} ${hubChannel.provider}`,
            action: {
              kind: 'run',
              run: () =>
                runSetSlot(target.name, slot, hubChannel.name, null, t("{0} 槽位绑到 {1}", [slot, hubChannel.name])),
            },
          });
          continue;
        }
        for (const model of hubChannel.models) {
          rows.push({
            id: `slot-${slot}-${hubChannel.name}-${model}`,
            group: 'slot',
            label: t("把 {0} 槽位绑到 {1} 的 {2}", [slot, hubChannel.name, model]),
            hint: hubChannel.resolvedChannelId === null ? t("渠道未解析") : (hubChannel.apiFormat ?? t("协议未知")),
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
                  t("{0} 槽位绑到 {1} 的 {2}", [slot, hubChannel.name, model]),
                ),
            },
          });
        }
      }

      if (rows.length === 0) {
        rows.push({
          id: `slot-${slot}-no-channels`,
          group: 'slot',
          label: t("hub {0} 还没声明 channels，先去模型槽位视图添加", [target.name]),
          hint: null,
          icon: 'warning',
          keywords: `${slot} channels`,
          action: { kind: 'run', run: () => goto('slots') },
        });
      }

      rows.push({
        id: `slot-${slot}-clear`,
        group: 'slot',
        label: t("清除 {0} 槽位的绑定", [slot]),
        hint: slotBindingText(target, slot),
        icon: 'close',
        keywords: t("{0} clear 清除", [slot]),
        action: {
          kind: 'run',
          run: () => runSetSlot(target.name, slot, null, null, t("{0} 槽位绑定已清除", [slot])),
        },
      });

      // effort 五档（DESIGN.md 第 4.1 节）：未设置 = 不写 effort_by_slot，落到内置默认档
      const currentEffort = toEffortChoice(target.effortBySlot[slot]);
      for (const choice of effortChoices(slot)) {
        const isCurrent = currentEffort === choice.value;
        const label =
          choice.value === EFFORT_UNSET
            ? t("清除 {0} 槽位的 effort 设置", [slot])
            : t("把 {0} 槽位的 effort 设为 {1}", [slot, choice.label]);
        const hintParts = [
          isCurrent ? t("当前") : null,
          choice.value === EFFORT_UNSET ? t("内置默认档 {0}", [SLOT_DEFAULT_EFFORT[slot]]) : null,
        ].filter((part): part is string => part !== null);
        rows.push({
          id: `slot-${slot}-effort-${choice.value}`,
          group: 'slot',
          label,
          hint: hintParts.length === 0 ? null : hintParts.join(' · '),
          icon: 'zap',
          keywords: `${slot} effort ${choice.label}`,
          action: {
            kind: 'run',
            run: () => runSetSlotEffort(target.name, slot, fromEffortChoice(choice.value), label),
          },
        });
      }
      return rows;
    }

    // 一级：导航 + 渠道 + 槽位 + 动作
    const rows: PaletteItem[] = [];

    for (const meta of VIEW_LIST) {
      rows.push({
        id: `nav-${meta.id}`,
        group: 'nav',
        label: t("转到 {0}", [meta.title]),
        hint: viewShortcut(meta.id),
        icon: meta.icon,
        keywords: `${meta.navLabel} ${meta.subtitle}`,
        action: { kind: 'run', run: () => goto(meta.id) },
      });
    }

    // 最近使用（REDESIGN-PROMPT 第 2.3 节）：按 Channel.lastUsedAt 倒序的渠道启动动作，
    // 上限 MAX_RECENT 条。没用过任何渠道时整组为空，分组自然不渲染。
    const recentChannels = channels
      .filter((channel) => channel.lastUsedAt !== null)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, MAX_RECENT);
    for (const channel of recentChannels) {
      rows.push({
        id: `recent-${channel.appType}:${channel.id}`,
        group: 'recent',
        label: t("用 {0} 启动会话", [channel.name]),
        hint: t("最近使用 {0}", [formatRelative(channel.lastUsedAt)]),
        icon: 'clock',
        keywords: t("recent 最近 {0} {1}", [channel.alias ?? '', channel.endpoint ?? '']),
        action: {
          kind: 'run',
          run: () => runLaunch({ kind: 'channel', channelId: channel.id, appType: channel.appType }, t("用 {0} 启动会话", [channel.name])),
        },
      });
    }

    // 隐藏渠道不过滤：CONTRACT 明确「隐藏渠道别名与 id 仍然能启动」，面板只标注，不藏起来
    for (const channel of channels) {
      const notes: string[] = [channel.apiFormat];
      if (channel.hidden) notes.push(t("已隐藏"));
      if (channel.compatibility === 'incompatible') notes.push(t("语义不兼容"));
      if (channel.credential === 'missing') notes.push(t("凭证未配置"));
      rows.push({
        id: `channel-${channel.appType}:${channel.id}`,
        group: 'channel',
        label: t("用 {0} 启动会话", [channel.name]),
        hint: notes.join(' · '),
        icon: 'play',
        keywords: `${channel.alias ?? ''} ${channel.endpoint ?? ''} ${channel.declaredModel ?? ''}`,
        action: {
          kind: 'run',
          run: () => runLaunch({ kind: 'channel', channelId: channel.id, appType: channel.appType }, t("用 {0} 启动会话", [channel.name])),
        },
      });
      const manageHints = [
        channel.alias === null ? null : t("别名 {0}", [channel.alias]),
        channel.hidden ? t("已隐藏") : null,
      ].filter((part): part is string => part !== null);
      rows.push({
        id: `channel-manage-${channel.appType}:${channel.id}`,
        group: 'channel',
        label: t("管理 {0}（启动、隐藏、别名、覆盖）", [channel.name]),
        hint: manageHints.length === 0 ? null : manageHints.join(' · '),
        icon: 'edit',
        keywords: t("管理 隐藏 别名 覆盖 manage {0} {1}", [channel.alias ?? '', channel.endpoint ?? '']),
        action: { kind: 'enter', mode: { kind: 'channel', channelId: channel.id, appType: channel.appType } },
      });
    }

    if (hub) {
      for (const slot of SLOTS) {
        rows.push({
          id: `slot-enter-${slot}`,
          group: 'slot',
          label: t("设置 {0} 槽位", [slot]),
          hint: `${hub.name} · ${slotBindingText(hub, slot)}`,
          icon: 'slots',
          keywords: t("slot 槽位 {0} {1}", [slot, hub.name]),
          action: { kind: 'enter', mode: { kind: 'slot', hubName: hub.name, slot } },
        });
      }
    }

    rows.push({
      id: 'action-refresh-view',
      group: 'action',
      label: t("刷新当前视图（{0}）", [VIEW_META[view].title]),
      hint: '⌘R',
      icon: 'refresh',
      keywords: t("refresh 刷新"),
      action: {
        kind: 'run',
        run: async () => {
          await refreshView(view);
          const problems = refreshProblems(VIEW_REFRESH_KEY[view]);
          announce(
            problems.length === 0
              ? t("{0} 数据已刷新", [VIEW_META[view].title])
              : t("{0} 刷新未成功：{1}", [VIEW_META[view].title, problems.join('；')]),
          );
        },
      },
    });

    rows.push({
      id: 'action-refresh-all',
      group: 'action',
      label: t("刷新全部数据"),
      hint: t("渠道、hub、用量、诊断、账号池、体检"),
      icon: 'refresh',
      keywords: t("refresh all 全部 刷新"),
      action: {
        kind: 'run',
        run: async () => {
          await refreshAll();
          const problems = refreshProblems(REFRESH_KEYS);
          announce(problems.length === 0 ? t("全部数据已刷新") : t("刷新未全部成功：{0}", [problems.join('；')]));
        },
      },
    });

    // 用量时间窗与分桶粒度，预设与粒度文案跟用量视图工具栏同一份（parts/range.ts）。
    // setUsageRange 内部会触发重聚合，这里只播报「窗口已切换」这个事实，不替重聚合的结果打包票。
    const currentPreset = matchPreset(usageRange.fromTs);
    for (const preset of RANGE_PRESETS) {
      rows.push({
        id: `action-range-${preset}`,
        group: 'action',
        label: t("用量时间窗：{0}", [PRESET_LABEL[preset]]),
        hint: preset === currentPreset ? t("当前") : t("{0}分桶", [GRANULARITY_LABEL[PRESET_GRANULARITY[preset]]]),
        icon: 'clock',
        keywords: t("usage 用量 时间窗 范围 range {0}", [preset]),
        action: {
          kind: 'run',
          run: () => {
            setUsageRange({ ...rangeFor(preset), granularity: PRESET_GRANULARITY[preset] });
            announce(t("用量时间窗已切换为{0}，正在重新聚合", [PRESET_LABEL[preset]]));
          },
        },
      });
    }
    for (const granularity of ['hour', 'day'] as const) {
      rows.push({
        id: `action-granularity-${granularity}`,
        group: 'action',
        label: t("用量分桶粒度：{0}", [GRANULARITY_LABEL[granularity]]),
        hint: usageRange.granularity === granularity ? t("当前") : null,
        icon: 'usage',
        keywords: t("usage 用量 粒度 分桶 granularity {0}", [granularity]),
        action: {
          kind: 'run',
          run: () => {
            setUsageRange({ granularity });
            announce(t("用量分桶粒度已切换为{0}，正在重新聚合", [GRANULARITY_LABEL[granularity]]));
          },
        },
      });
    }

    rows.push({
      id: 'action-sidebar',
      group: 'action',
      label: sidebarCollapsed ? t("展开侧栏") : t("折叠侧栏"),
      hint: '⌘B',
      icon: 'sidebar',
      keywords: t("sidebar 侧栏 折叠 展开"),
      action: { kind: 'run', run: () => toggleSidebar() },
    });

    for (const candidate of THEME_SEQUENCE) {
      rows.push({
        id: `action-theme-${candidate}`,
        group: 'action',
        label: t("主题：{0}", [THEME_LABEL[candidate]]),
        hint: candidate === theme ? t("当前") : null,
        icon: candidate === 'dark' ? 'moon' : candidate === 'light' ? 'sun' : 'monitor',
        keywords: t("theme 主题 {0}", [candidate]),
        action: {
          kind: 'run',
          run: () => {
            setTheme(candidate);
            announce(t("主题已切换为{0}", [THEME_LABEL[candidate]]));
          },
        },
      });
    }

    // 界面大小三档（REDESIGN-PROMPT 第 2.3 节）：接 store/ui.ts 的 density，
    // 与设置页「外观」同一开关。这是「保存设置」类操作，成败反馈走 toast。
    for (const candidate of DENSITY_SEQUENCE) {
      rows.push({
        id: `action-density-${candidate}`,
        group: 'action',
        label: t("界面大小：{0}", [DENSITY_LABEL[candidate]]),
        hint: candidate === density ? t("当前") : null,
        icon: 'monitor',
        keywords: t("density 界面大小 缩放 {0}", [candidate]),
        action: {
          kind: 'run',
          run: () => {
            setDensity(candidate);
            toastSuccess(t("界面大小已切换为{0}", [DENSITY_LABEL[candidate]]));
            announce(t("界面大小已切换为{0}", [DENSITY_LABEL[candidate]]));
          },
        },
      });
    }

    rows.push({
      id: 'action-copy-diagnostics',
      group: 'action',
      label: t("复制诊断报告"),
      hint: t("体检结论与最近错误摘要进剪贴板"),
      icon: 'copy',
      keywords: t("copy 复制 诊断 报告 diagnostics report"),
      action: { kind: 'run', run: runCopyDiagnostics },
    });

    rows.push({
      id: 'action-doctor',
      group: 'action',
      label: t("运行本机体检"),
      hint: t("只读不联网"),
      icon: 'doctor',
      keywords: t("doctor 体检 检查"),
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
        label: t("在 Finder 中显示配置文件"),
        hint: env.configPath,
        icon: 'reveal',
        keywords: t("config 配置 目录 finder"),
        action: { kind: 'run', run: () => runOpen(env.configPath, t("已定位配置文件"), true) },
      });
      rows.push({
        id: 'action-open-logs',
        group: 'action',
        label: t("打开日志目录"),
        hint: env.logsDir,
        icon: 'external',
        keywords: t("log 日志 目录"),
        action: { kind: 'run', run: () => runOpen(env.logsDir, t("已打开日志目录"), false) },
      });
    }

    if (hub) {
      rows.push({
        id: 'action-launch-hub',
        group: 'action',
        label: t("启动 hub {0} 的会话", [hub.name]),
        hint: hub.running ? t("hub 正在运行") : t("hub 未运行"),
        icon: 'terminal',
        keywords: t("hub launch 启动"),
        action: {
          kind: 'run',
          run: () => runLaunch({ kind: 'hub', hubName: hub.name }, t("启动 hub {0} 的会话", [hub.name])),
        },
      });
      for (const slot of SLOTS) {
        if (!hub.slots[slot]) continue;
        rows.push({
          id: `action-launch-slot-${slot}`,
          group: 'action',
          label: t("按 {0} 槽位启动会话", [slot]),
          hint: slotBindingText(hub, slot),
          icon: 'play',
          keywords: t("launch 启动 槽位 {0}", [slot]),
          action: {
            kind: 'run',
            run: () => runLaunch({ kind: 'slot', hubName: hub.name, slot }, t("按 {0} 槽位启动会话", [slot])),
          },
        });
      }
    }

    return rows;
  }, [
    announce,
    channels,
    density,
    env,
    hubs,
    launch,
    mode,
    openPath,
    query,
    refresh,
    refreshAll,
    revealInFolder,
    setAlias,
    setDensity,
    setHidden,
    setOverride,
    setSlot,
    setSlotEffort,
    setTheme,
    setUsageRange,
    setView,
    sidebarCollapsed,
    theme,
    toastError,
    toastSuccess,
    toggleSidebar,
    usageRange,
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

  /**
   * 遮罩淡入。面板本体的入场归 CSS 的 palette-in 关键帧（--dur-slow），遮罩这一层是
   * 「面板入场」那档 --dur-normal（DESIGN.md 第 2.5 节时长语义表）：先铺底再浮面板，
   * 免得 50% 黑底一帧砸下来。
   * transition 只在挂载后翻一次状态才会跑，所以要等一帧——rAF 保证第一帧遮罩是透明的。
   * 减少动效模式下 background-color 仍在放行名单里，只是被压到 --dur-instant，遮罩不会消失。
   */
  const [scrimIn, setScrimIn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setScrimIn(true));
    return () => cancelAnimationFrame(frame);
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
      .catch((cause: unknown) => announce(t("命令执行未成功：{0}", [errorText(cause)])));
  };

  const backToRoot = (): void => {
    setMode({ kind: 'root' });
    setQuery('');
    inputRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // IME 组合中的按键是选词不是命令（Composer 同款守卫）：拼音里按 Enter/Esc
    // 只该作用于候选窗，执行高亮命令或关面板都会把用户输入截走。
    if (event.nativeEvent.isComposing) return;
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
    if (event.key === 'Backspace' && query === '' && mode.kind !== 'root') {
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
    // 同上：IME 组合中的 Esc 是取消候选词，不该退级/关面板
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (mode.kind !== 'root') backToRoot();
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
      className={cx(styles.overlay, scrimIn && styles.overlayIn)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("命令面板")}
        onKeyDown={onPanelKeyDown}
      >
        <div className={styles.inputRow}>
          <Icon name="search" className={styles.searchIcon} />
          {mode.kind === 'root' ? null : (
            <span className={styles.scope}>
              {mode.kind === 'slot'
                ? t("槽位 · {0}", [mode.slot])
                : t("渠道 · {0}", [channels.find((candidate) => candidate.id === mode.channelId && candidate.appType === mode.appType)?.name ?? mode.channelId])}
              <button type="button" className={styles.scopeBack} onClick={backToRoot} aria-label={t("返回全部命令")}>
                <Icon name="close" size={14} />
              </button>
            </span>
          )}
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode.kind === 'slot'
                ? t("筛选渠道与模型")
                : mode.kind === 'channel'
                  ? t("筛选动作；输入的文字可直接设为别名或模型覆盖")
                  : t("输入命令：切视图、启动会话、改槽位、管理渠道、刷新、切主题")
            }
            role="combobox"
            aria-expanded={true}
            aria-controls="palette-list"
            aria-activedescendant={activeIndex >= 0 ? `palette-item-${activeIndex}` : undefined}
            aria-label={t("命令输入")}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className={styles.list} id="palette-list" role="listbox" aria-label={t("命令结果")} ref={listRef}>
          {rows.length === 0 ? (
            <p className={styles.empty}>{t("没有命令匹配「")}{query.trim()}{t("」，换个说法再试")}</p>
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
                  <p className={styles.more}>{t("还有 ")}{group.hidden}{t(" 条未显示，继续输入以筛选")}</p>
                ) : null}
              </section>
            ))
          )}
        </div>

        <div className={styles.legend}>
          <span>{t("↑↓ 移动")}</span>
          <span>{t("Enter 执行")}</span>
          <span>{mode.kind === 'root' ? t("Esc 关闭") : t("Esc 返回")}</span>
        </div>
      </div>
    </div>
  );
}
