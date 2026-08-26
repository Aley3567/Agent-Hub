/**
 * 一个槽位一行：槽位名、绑定渠道、目标模型、effort 档位、最近 24 小时调用量。
 *
 * 三条写死的行为：
 *   1. 改动即写：Select / SegmentedControl 一变就调 store 的 setSlot / setSlotEffort，
 *      不留「保存」按钮，也不留本地草稿——界面永远等于配置里的真实状态。
 *   2. 写入期间整行禁用并显示 Spinner；成功给一次轻量反馈，失败把 IPC 的中文原文
 *      原样贴在行下方（AGENTS.md：错误原样暴露，绝不改写成「保存失败」）。
 *   3. 未绑定不留空白：说明它会走 fallback，并把 fallback 的确切落点写出来。
 */
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, SegmentedControl, Spinner, StatusDot, Tooltip } from '../../../components';
import { Sparkline } from '../../../components/charts';
import { formatCount, formatTokens } from '../../../lib';
import { errorText, useApp } from '../../../store';
import { useNav } from '../../../store/nav';
import type { Channel, HubConfig, SlotName } from '../../../types/contract';
import {
  type EffortChoice,
  type FallbackInfo,
  type SlotUsage,
  effortChoices,
  findHubChannelByName,
  fromEffortChoice,
  resolvedChannel,
  slotHitText,
  toEffortChoice,
} from '../slotModel';
import { SlotPicker } from './SlotPicker';
import styles from './SlotRow.module.css';

/** 成功反馈停留多久。轻量提示，不做 toast 队列 */
const SAVED_TTL = 1600;

export interface SlotRowProps {
  hub: HubConfig;
  slot: SlotName;
  /** 渠道 id → 本机渠道，用来显示 hub 渠道背后的真名与兼容性结论 */
  channelsById: Map<string, Channel>;
  /** 本机可用但尚未加入本 hub 的渠道 */
  undeclared: Channel[];
  usage: SlotUsage;
  /** 用量口径覆盖不到本 hub 时给出原因，覆盖得到时为 null */
  usageGap: string | null;
  fallback: FallbackInfo;
}

export function SlotRow({ hub, slot, channelsById, undeclared, usage, usageGap, fallback }: SlotRowProps) {
  const setSlot = useApp((state) => state.setSlot);
  const setSlotEffort = useApp((state) => state.setSlotEffort);
  const setView = useNav((state) => state.setView);

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const binding = hub.slots[slot] ?? null;
  const effort = hub.effortBySlot[slot] ?? null;
  const hubChannel = findHubChannelByName(hub.channels, binding === null ? null : binding.channel);
  const real = resolvedChannel(hubChannel, channelsById);
  const isLaunchSlot = hub.launchSlot === slot;

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setSaving(true);
    setFailure(null);
    setSaved(null);
    try {
      await action();
      setSaved(label);
      timer.current = window.setTimeout(() => {
        setSaved(null);
        timer.current = null;
      }, SAVED_TTL);
    } catch (cause) {
      setFailure(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  function commitBinding(channel: string | null, model: string | null): void {
    if (channel === null || model === null) {
      if (binding === null) return;
      void run('已清除绑定', () => setSlot(hub.name, slot, null, null));
      return;
    }
    const same =
      binding !== null &&
      binding.channel.trim().toLowerCase() === channel.trim().toLowerCase() &&
      binding.model === model;
    if (same) return;
    void run(`已绑定 ${channel},${model}`, () => setSlot(hub.name, slot, channel, model));
  }

  function commitEffort(choice: EffortChoice): void {
    const next = fromEffortChoice(choice);
    if (next === effort) return;
    void run(next === null ? '已清除 effort' : `effort 已设为 ${next}`, () =>
      setSlotEffort(hub.name, slot, next),
    );
  }

  return (
    <li className={styles.item}>
      <div className={styles.line}>
        <div className={styles.cell}>
          <span className={styles.label}>槽位</span>
          <Tooltip content={slotHitText(slot)}>
            <span className={styles.slotName}>{slot}</span>
          </Tooltip>
          {isLaunchSlot ? <Badge tone="accent">启动槽位</Badge> : null}
          <span className={styles.status} aria-live="polite">
            {saving ? <Spinner size="sm" label="写入中" /> : null}
            {!saving && saved !== null ? <StatusDot tone="ok">{saved}</StatusDot> : null}
          </span>
        </div>

        <SlotPicker
          slot={slot}
          hubChannels={hub.channels}
          undeclared={undeclared}
          channelsById={channelsById}
          binding={binding}
          disabled={saving}
          onCommit={commitBinding}
        />

        <div className={styles.cell}>
          <span className={styles.label}>effort 档位</span>
          <SegmentedControl
            options={effortChoices(slot)}
            value={toEffortChoice(effort)}
            onChange={commitEffort}
            disabled={saving}
            fullWidth
            truncate={false}
            aria-label={`${slot} 槽位的 effort 档位`}
          />
        </div>

        <div className={styles.cell}>
          <span className={styles.label}>最近 24 小时</span>
          {usageGap !== null ? (
            <Tooltip content={usageGap}>
              <span className={styles.usageNote}>口径不覆盖本 hub</span>
            </Tooltip>
          ) : binding === null ? (
            <span className={styles.usageNote}>未绑定，没有可统计的调用</span>
          ) : (
            <>
              <Sparkline
                data={usage.turns === 0 ? [] : usage.buckets}
                emptyText="24 小时无调用"
                ariaLabel={`${slot} 槽位最近 24 小时每小时的调用回合数，合计 ${usage.turns} 回合`}
                height={24}
              />
              <span className={styles.usageMeta} title="未配置价格表，不估算成本">
                {`${formatCount(usage.turns)} 回合 · ${formatTokens(usage.tokens)} tokens`}
              </span>
            </>
          )}
        </div>
      </div>

      <div className={styles.notes}>
        {failure === null ? null : (
          <p className={styles.noteDanger} role="alert">
            {failure}
          </p>
        )}

        {binding === null ? (
          <p className={fallback.ok ? styles.note : styles.noteDanger}>
            <StatusDot tone="off">未绑定，将走 fallback</StatusDot>
            <span className={styles.noteText}>{fallback.text}</span>
          </p>
        ) : null}

        {binding !== null && hubChannel === null ? (
          <p className={styles.noteDanger}>
            {`本行绑定的渠道 ${binding.channel} 不在本 hub 的 channels 里。claude1 启动这个 hub 时会报「model_slots.${slot} 必须引用已声明的渠道模型」，先换成已声明的渠道。`}
          </p>
        ) : null}

        {binding !== null && hubChannel !== null && !hubChannel.models.includes(binding.model) ? (
          <p className={styles.noteDanger}>
            {`hub 渠道 ${hubChannel.name} 没有声明模型 ${binding.model}${
              hubChannel.models.length === 0 ? '（它一个模型都没声明）' : `（它声明的是 ${hubChannel.models.join('、')}）`
            }。claude1 启动这个 hub 时会报「model_slots.${slot} 必须引用已声明的渠道模型」。`}
          </p>
        ) : null}

        {real !== null && real.compatibility === 'incompatible' ? (
          <p className={styles.noteWarn}>
            <StatusDot tone="degraded">不兼容</StatusDot>
            <span className={styles.noteText}>
              {`渠道 ${real.name} 的 Claude Code 语义兼容性结论是 incompatible${
                real.compatibilityReason === null ? '' : `：${real.compatibilityReason}`
              }`}
            </span>
            <Button variant="ghost" size="sm" icon="diagnostics" onClick={() => setView('diagnostics')}>
              去诊断视图
            </Button>
          </p>
        ) : null}

        {hubChannel !== null && hubChannel.resolvedChannelId === null ? (
          <p className={styles.note}>
            {`hub 渠道 ${hubChannel.name} 的 provider 选择器「${hubChannel.provider}」没解析到本机渠道，凭证与端点都得看 hub 配置自己怎么写。`}
          </p>
        ) : null}
      </div>
    </li>
  );
}
