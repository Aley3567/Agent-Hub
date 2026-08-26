/**
 * 模型槽位视图：四个槽位分别绑到哪个渠道的哪个模型。
 *
 * 这是本产品相对 cc-switch 的核心差异化能力——多个模型同时在线，靠 hub 的四个原生槽位
 * 各自指向不同渠道实现。所以这一页按 hub 分区，每个 hub 把四行槽位摊开讲清楚：
 * 绑了谁、用什么档位、最近 24 小时被调了多少、没绑的会落到哪里。
 *
 * 数据全部来自 store（CONTRACT.md 6.1 节：视图无 props，自己取数）。写入只经 setSlot /
 * setSlotEffort 两个动作，失败原文照贴。
 */
import { useMemo, useState } from 'react';
import { Button, EmptyState, IconButton, Select, StatusDot, Toolbar } from '../../components';
import { errorText, useApp } from '../../store';
import { useAnnouncer } from '../../shell/announce';
import type { Channel } from '../../types/contract';
import { HubCard } from './parts/HubCard';
import { buildFillPlan } from './slotModel';
import styles from './index.module.css';

/** hub 范围选择里「全部展开」的哨兵值。hub 名不可能是空串，所以不会撞车 */
const ALL_HUBS = '';

type FillTone = 'ok' | 'skip' | 'fail' | 'info';

interface FillLine {
  hub: string;
  tone: FillTone;
  text: string;
}

const FILL_TONE: Record<FillTone, 'ok' | 'degraded' | 'fail' | 'off'> = {
  ok: 'ok',
  skip: 'degraded',
  fail: 'fail',
  info: 'off',
};

export default function SlotsView() {
  const hubs = useApp((state) => state.hubs);
  const channels = useApp((state) => state.channels);
  const usageRows = useApp((state) => state.recentUsage);
  const refresh = useApp((state) => state.refresh);
  const setSlot = useApp((state) => state.setSlot);
  const offline = useApp((state) => state.offline);
  const loadingHubs = useApp((state) => state.loading.hubs === true);
  const loadingChannels = useApp((state) => state.loading.channels === true);
  const loadingUsage = useApp((state) => state.loading.usage === true);
  const hubsError = useApp((state) => state.error.hubs ?? null);
  const channelsError = useApp((state) => state.error.channels ?? null);
  const usageError = useApp((state) => state.error.usage ?? null);
  const announce = useAnnouncer((state) => state.announce);

  const [scope, setScope] = useState<string>(ALL_HUBS);
  const [filling, setFilling] = useState(false);
  const [report, setReport] = useState<FillLine[] | null>(null);

  const channelsById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of channels) map.set(channel.id, channel);
    return map;
  }, [channels]);

  /**
   * 统计基准时刻。故意只在用量流水变化时重算：同一屏里四行乃至多个 hub 必须落在同一个
   * 24 小时窗口上，否则相邻两行的「最近 24 小时」口径会差出几秒钟。
   */
  const now = useMemo(() => Math.floor(Date.now() / 1000), [usageRows]);

  const scopeKnown = scope !== ALL_HUBS && hubs.some((hub) => hub.name === scope);
  const visible = scopeKnown ? hubs.filter((hub) => hub.name === scope) : hubs;
  const current = channels.find((channel) => channel.isCurrent) ?? null;
  const busy = loadingHubs || loadingChannels || loadingUsage;

  async function reload(): Promise<void> {
    await Promise.all([refresh('hubs'), refresh('channels'), refresh('usage')]);
  }

  /**
   * 按 CC Switch 当前渠道填充四个槽位。逐个 await 而不是并发：每次 setSlot 都要读改写同一份
   * hub json，并发写会互相盖掉。填不了的槽位不硬填，把原因逐条列出来。
   */
  async function fillFromCurrent(): Promise<void> {
    setFilling(true);
    setReport(null);
    const lines: FillLine[] = [];
    for (const hub of visible) {
      const plan = buildFillPlan(hub, current);
      if (!plan.ok) {
        lines.push({ hub: hub.name, tone: 'skip', text: plan.blocked });
        continue;
      }
      for (const item of plan.items) {
        if (!item.fill) {
          lines.push({ hub: hub.name, tone: 'skip', text: `${item.slot}：跳过 —— ${item.reason}` });
          continue;
        }
        if (item.unchanged) {
          lines.push({ hub: hub.name, tone: 'info', text: `${item.slot}：已经是 ${plan.alias},${item.model}，不用改` });
          continue;
        }
        try {
          await setSlot(hub.name, item.slot, plan.alias, item.model);
          lines.push({ hub: hub.name, tone: 'ok', text: `${item.slot}：已绑定 ${plan.alias},${item.model}` });
        } catch (cause) {
          lines.push({ hub: hub.name, tone: 'fail', text: `${item.slot}：写入失败 —— ${errorText(cause)}` });
        }
      }
    }
    setReport(lines);
    setFilling(false);
    const written = lines.filter((line) => line.tone === 'ok').length;
    const failed = lines.filter((line) => line.tone === 'fail').length;
    announce(`一键填充结束：写入 ${written} 个槽位，失败 ${failed} 个，其余保持原样`);
  }

  const fillHint =
    current === null
      ? 'CC Switch 没有标记当前渠道，没有可以照着填的渠道'
      : `当前渠道 ${current.name}；只写它在 hub 里声明过的模型，填不了的槽位会逐条说明原因`;
  /** 填充作用范围跟着上面的展开范围走，按钮上要说清是一个 hub 还是全部 */
  const fillScope = scopeKnown
    ? `只作用于 hub ${scope}`
    : `作用于展开中的全部 ${visible.length} 个 hub`;

  return (
    <div className={styles.view}>
      {loadingHubs && hubs.length === 0 ? (
        <div className="app-progress" role="progressbar" aria-label="正在读取 hub 配置" />
      ) : null}

      <Toolbar
        aria-label="槽位视图工具栏"
        divider
        right={
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            loading={busy}
            onClick={() => void reload()}
            title="重读 hub 配置、渠道列表与用量流水"
          >
            刷新
          </Button>
        }
      >
        <span className={styles.scope}>
          <Select
            selectSize="sm"
            mono
            aria-label="要展开的 hub"
            value={scopeKnown ? scope : ALL_HUBS}
            onChange={(event) => setScope(event.target.value)}
            options={[
              { value: ALL_HUBS, label: `全部展开（${hubs.length} 个 hub）` },
              ...hubs.map((hub) => ({ value: hub.name, label: hub.name })),
            ]}
          />
        </span>
        <Button
          size="sm"
          icon="zap"
          loading={filling}
          disabled={current === null || visible.length === 0}
          onClick={() => void fillFromCurrent()}
          title={`${fillScope}。${fillHint}`}
        >
          按当前渠道一键填充四槽
        </Button>
        <span className={styles.hint}>{fillHint}</span>
      </Toolbar>

      <p className={styles.caption}>
        槽位改动直接落到 hub 的配置文件；hub 正在运行时，改动要等下次启动才生效。最近 24 小时调用量按「渠道别名 +
        模型 id」从 store 里最近 <span className={styles.mono}>{usageRows.length}</span>{' '}
        条用量流水统计，早于这批记录的调用不计入，所以它是下限而不是全量；未配置价格表，不估算成本。
      </p>

      {offline ? (
        <p className={styles.warn}>
          当前显示的是离线示例数据（Rust 侧不可用），槽位改动不会写进本机配置。
        </p>
      ) : null}

      {hubsError === null ? null : (
        <p className={styles.danger} role="alert">
          hub 配置没读到：{hubsError}
        </p>
      )}
      {channelsError === null ? null : (
        <p className={styles.danger} role="alert">
          渠道列表没读到：{channelsError}（下拉里的渠道会不全）
        </p>
      )}
      {usageError === null ? null : (
        <p className={styles.danger} role="alert">
          用量流水没读到：{usageError}（各行的 24 小时调用量会是空的）
        </p>
      )}

      {report === null ? null : (
        <section className={styles.report} aria-label="一键填充结果">
          <div className={styles.reportHead}>
            <span className={styles.reportTitle}>一键填充结果</span>
            <IconButton icon="close" aria-label="关闭填充结果" onClick={() => setReport(null)} />
          </div>
          <ul className={styles.reportList}>
            {report.map((line, index) => (
              <li key={`${line.hub}-${index}`} className={styles.reportLine}>
                <StatusDot tone={FILL_TONE[line.tone]}>
                  <span className={styles.mono}>{line.hub}</span>
                </StatusDot>
                <span className={styles.reportText}>{line.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hubs.length === 0 && !loadingHubs ? (
        <EmptyState
          icon="slots"
          title="本机还没有可用的 hub 配置"
          description="读不到 ~/.cc-switch/claude-hub.json，命名 hub 注册表也是空的，所以没有槽位可以绑定。"
          action={{ label: '重新读取', icon: 'refresh', onClick: () => void reload() }}
          hint={
            <span className={styles.mono}>cp examples/claude-hub.example.json ~/.cc-switch/claude-hub.json</span>
          }
        />
      ) : (
        <div className={styles.hubs}>
          {visible.map((hub) => (
            <HubCard
              key={hub.name}
              hub={hub}
              channels={channels}
              channelsById={channelsById}
              usageRows={usageRows}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
