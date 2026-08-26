/**
 * 常驻状态栏，高 28px。它是产品定位的直接体现：多渠道 / 多模型的真实状态要一眼看到
 * （DESIGN.md 第 3 节）。左侧是当前渠道、槽位、hub 端口、今日 token、降级数，
 * 技术标识一律 mono；右侧是播报区与离线徽章。
 *
 * 离线徽章不是装饰：api 层回退到内置示例数据时必须显示它，绝不让假数据冒充真实数据
 * （CONTRACT.md 第 4 节）。
 */
import { Badge, StatusDot, Tooltip } from '../components';
import { MISSING, formatTokens } from '../lib';
import { pickDefaultHub, startOfTodaySeconds, useApp } from '../store';
import type { UsageSummary } from '../types/contract';
import { useAnnouncer } from './announce';
import styles from './StatusBar.module.css';

/**
 * 今日 token = 时间窗内落在今天的桶之和（input + output）。
 * 窗口整个早于今天时返回 null——那种情况下我们对今天一无所知，显示破折号而不是 0。
 */
function todayTokens(usage: UsageSummary | null): number | null {
  if (!usage) return null;
  const start = startOfTodaySeconds();
  if (usage.windowTo < start) return null;
  let total = 0;
  for (const bucket of usage.series) {
    if (bucket.t >= start) total += bucket.in + bucket.out;
  }
  return total;
}

function degradeTotal(usage: UsageSummary | null): number | null {
  if (!usage) return null;
  return usage.degradeCounts.reduce((sum, item) => sum + item.count, 0);
}

export default function StatusBar() {
  const channels = useApp((state) => state.channels);
  const hubs = useApp((state) => state.hubs);
  const usage = useApp((state) => state.usage);
  const offline = useApp((state) => state.offline);
  const message = useAnnouncer((state) => state.message);

  const current = channels.find((channel) => channel.isCurrent) ?? null;
  const hub = pickDefaultHub(hubs);
  const portText = hub === null || hub.port === null ? '未配置' : String(hub.port);
  const today = todayTokens(usage);
  const degraded = degradeTotal(usage);

  return (
    <footer className={styles.bar}>
      <div className={styles.left}>
        <Tooltip content="CC Switch 当前选中的渠道" side="top">
          <span className={styles.cell}>
            <span className={styles.label}>渠道</span>
            <span className={styles.value}>{current ? current.name : '未选定'}</span>
          </span>
        </Tooltip>

        <span className={styles.sep} aria-hidden="true">
          ·
        </span>

        <Tooltip content="默认 hub 的启动槽位" side="top">
          <span className={styles.cell}>
            <span className={styles.label}>槽位</span>
            <span className={styles.value}>{hub?.launchSlot ?? '未设置'}</span>
          </span>
        </Tooltip>

        <span className={styles.sep} aria-hidden="true">
          ·
        </span>

        <Tooltip content={hub ? `hub ${hub.name} 的监听端口` : '还没有 hub 配置'} side="top">
          <span className={styles.cell}>
            <span className={styles.label}>hub</span>
            <span className={styles.value}>{portText}</span>
            {hub ? (
              <StatusDot tone={hub.running ? 'ok' : 'off'}>{hub.running ? '运行中' : '未运行'}</StatusDot>
            ) : null}
          </span>
        </Tooltip>

        <span className={styles.sep} aria-hidden="true">
          ·
        </span>

        <Tooltip content="今天的 input + output token，取自用量视图的时间窗" side="top">
          <span className={styles.cell}>
            <span className={styles.label}>今日</span>
            <span className={styles.value}>{today === null ? MISSING : formatTokens(today)}</span>
          </span>
        </Tooltip>

        <span className={styles.sep} aria-hidden="true">
          ·
        </span>

        <Tooltip content="时间窗内记到的降级次数，明细看诊断视图" side="top">
          <span className={styles.cell}>
            <span className={styles.label}>降级</span>
            <span className={degraded !== null && degraded > 0 ? styles.valueWarn : styles.value}>
              {degraded === null ? MISSING : degraded}
            </span>
          </span>
        </Tooltip>
      </div>

      {/* 启动结果与体检结论走这里播报（DESIGN.md 第 6 节） */}
      <p className={styles.live} aria-live="polite">
        {message}
      </p>

      {offline ? (
        <Tooltip content="Rust 侧不可用，界面显示的是内置示例数据，不是本机真实数据" side="left">
          <Badge tone="warn">离线示例数据</Badge>
        </Tooltip>
      ) : null}
    </footer>
  );
}
