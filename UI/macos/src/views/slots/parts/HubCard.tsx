/**
 * 一个 hub 一张卡：头部是 hub 名、监听端口、运行状态，主体是四个槽位，底部是启动会话。
 *
 * 启动按钮走 store 的 launch，拿回来的 LaunchResult.command 一定回显出来
 * （CONTRACT.md 3.1 节：让用户看到桌面端到底跑了什么）。ok 为 false 时按失败呈现，
 * 不因为「调用没抛异常」就说成成功。
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Card, CodeBlock, StatusDot } from '../../../components';
import { errorText, useApp } from '../../../store';
import { useNav } from '../../../store/nav';
import { useToast } from '../../../store/toast';
import { useAnnouncer } from '../../../shell/announce';
import type { Channel, HubConfig, LaunchResult, SlotName, UsageRow } from '../../../types/contract';
import {
  SLOT_DEFAULT_EFFORT,
  SLOT_ORDER,
  findHubChannelByName,
  hubFallback,
  protocolLabel,
  slotUsage,
  undeclaredChannels,
} from '../slotModel';
import { SlotRow } from './SlotRow';
import styles from './HubCard.module.css';

export interface HubCardProps {
  hub: HubConfig;
  /** 本机渠道全量（含 hidden，过滤在 slotModel 里做） */
  channels: Channel[];
  channelsById: Map<string, Channel>;
  /** 用量流水，用来切每个槽位最近 24 小时的调用量 */
  usageRows: UsageRow[];
  /** 统计基准时刻（unix 秒），由视图统一给，保证同一屏的窗口一致 */
  now: number;
}

interface HubWarning {
  key: string;
  /** 一句说明。槽位名与回合计数是标识符 / 数字，按 DESIGN.md 1.3 与 2.3 走 mono */
  text: ReactNode;
}

/** 把同一 hub 内重复的降级提示合并成一条，避免每个槽位都撑一条满宽琥珀条。 */
function buildHubWarnings(hub: HubConfig, usageRows: UsageRow[], now: number): HubWarning[] {
  const out: HubWarning[] = [];

  // 按协议格式聚合跨协议提示
  const formatSlots = new Map<string, SlotName[]>();
  for (const slot of SLOT_ORDER) {
    const binding = hub.slots[slot] ?? null;
    if (binding === null) continue;
    const hubChannel = findHubChannelByName(hub.channels, binding.channel);
    const format = hubChannel?.apiFormat ?? null;
    if (format === 'anthropic' || format === null) continue;
    const label = protocolLabel(format);
    const list = formatSlots.get(label) ?? [];
    list.push(slot);
    formatSlots.set(label, list);
  }
  for (const [label, slots] of formatSlots) {
    out.push({
      key: `protocol-${label}`,
      text: (
        <>
          <span className={styles.mono}>{slots.join('、')}</span> 槽位绑定到 {label} 渠道，会产生
          HUB_DEGRADE_* 降级。
        </>
      ),
    });
  }

  // 聚合最近 24 小时的降级回合数
  let degraded = 0;
  for (const slot of SLOT_ORDER) {
    const binding = hub.slots[slot] ?? null;
    if (binding === null) continue;
    degraded += slotUsage(usageRows, binding, now).degraded;
  }
  if (degraded > 0) {
    out.push({
      key: 'degraded',
      text: (
        <>
          最近 24 小时本 hub 有 <span className={styles.mono}>{degraded}</span> 个回合带
          HUB_DEGRADE_* 降级码。
        </>
      ),
    });
  }

  return out;
}

export function HubCard({ hub, channels, channelsById, usageRows, now }: HubCardProps) {
  const launch = useApp((state) => state.launch);
  const announce = useAnnouncer((state) => state.announce);
  const setView = useNav((state) => state.setView);
  // 启动反馈统一走 toast（REDESIGN-PROMPT 2.3.5）；卡内的命令回显与失败原文保留，
  // toast 只是 3 秒的轻反馈，不替代留痕
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);

  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const warnings = useMemo(() => buildHubWarnings(hub, usageRows, now), [hub, usageRows, now]);

  const undeclared = undeclaredChannels(hub, channels);
  const fallback = hubFallback(hub);

  /**
   * 命名 hub 的用量写在 logs/hubs/<name>-usage.jsonl，而 store 里的流水取的是默认 hub 的 journal，
   * 所以这里如实说明口径覆盖不到，绝不拿默认 hub 的数字冒充命名 hub 的。
   */
  const usageGap = hub.isDefault
    ? null
    : `本视图的用量流水取自默认 hub 的 journal，命名 hub ${hub.name} 的流水在 logs/hubs/${hub.name}-usage.jsonl，这里统计不到。`;

  /** 启动落在哪个槽位、用哪一档 effort：launch_slot 未设置时 claude1 用 fable 兜底 */
  const launchSlot = hub.launchSlot ?? 'fable';
  const launchEffort = hub.effortBySlot[launchSlot] ?? SLOT_DEFAULT_EFFORT[launchSlot];
  const launchHint =
    hub.launchSlot === null
      ? `未设置 launch_slot，claude1 用 fable 兜底，effort ${launchEffort}`
      : `启动后停在槽位 ${launchSlot}，effort ${launchEffort}`;

  async function startSession(): Promise<void> {
    setLaunching(true);
    setFailure(null);
    setResult(null);
    try {
      const next = await launch({ kind: 'hub', hubName: hub.name });
      setResult(next);
      announce(next.ok ? `hub ${hub.name} 的会话已启动：${next.message}` : `hub ${hub.name} 启动失败：${next.message}`);
      if (next.ok) toastSuccess(`hub ${hub.name} 的会话已启动`);
      else toastError(next.message);
    } catch (cause) {
      const reason = errorText(cause);
      setFailure(reason);
      announce(`hub ${hub.name} 启动失败：${reason}`);
      toastError(reason);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Card
      title={
        <>
          <span className={styles.hubName}>{hub.name}</span>
          <Badge tone={hub.isDefault ? 'accent' : 'neutral'} mono={false}>
            {hub.isDefault ? '默认 hub' : '命名 hub'}
          </Badge>
        </>
      }
      subtitle={
        <span className={styles.meta}>
          <span>
            监听端口 <span className={styles.mono}>{hub.port === null ? '未配置' : hub.port}</span>
          </span>
          <span>
            配置版本 <span className={styles.mono}>v{hub.version}</span>
          </span>
          <span className={styles.path}>{hub.configPath}</span>
        </span>
      }
      actions={
        <StatusDot
          tone={hub.running ? 'ok' : 'off'}
          title={hub.running ? '读 .lock 并探测回环端口，确认有活着的进程' : '没有活着的进程，槽位改动会在下次启动时生效'}
        >
          {hub.running ? '运行中' : '未运行'}
        </StatusDot>
      }
      footer={
        <div className={styles.footer}>
          <div className={styles.footerRow}>
            <Button variant="primary" size="sm" icon="play" loading={launching} onClick={() => void startSession()}>
              启动会话
            </Button>
            <span className={styles.footerHint}>{launchHint}</span>
          </div>
          {failure === null ? null : (
            <p className={styles.launchFail} role="alert">
              {failure}
            </p>
          )}
          {result === null ? null : (
            <div className={styles.launchResult}>
              <StatusDot tone={result.ok ? 'ok' : 'fail'}>{result.ok ? '已交给终端执行' : '启动失败'}</StatusDot>
              <p className={result.ok ? styles.launchMessage : styles.launchFail}>{result.message}</p>
              <CodeBlock label="实际执行的命令" code={result.command} />
            </div>
          )}
        </div>
      }
    >
      {warnings.length === 0 ? null : (
        <div className={styles.hubWarnings}>
          {warnings.map((warning) => (
            <p key={warning.key} className={styles.hubWarning}>
              <StatusDot tone="degraded">降级提示</StatusDot>
              <span>{warning.text}</span>
              <Button variant="ghost" size="sm" icon="diagnostics" onClick={() => setView('diagnostics')}>
                去诊断视图
              </Button>
            </p>
          ))}
        </div>
      )}

      <div className={styles.slotsScroll}>
        <ul className={styles.slots}>
          {SLOT_ORDER.map((slot) => (
            <SlotRow
              key={slot}
              hub={hub}
              slot={slot}
              channelsById={channelsById}
              undeclared={undeclared}
              usage={slotUsage(usageRows, hub.slots[slot] ?? null, now)}
              usageGap={usageGap}
              fallback={fallback}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}
