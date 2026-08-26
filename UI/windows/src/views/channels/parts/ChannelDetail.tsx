/**
 * 展开行的详情面板：这个渠道到底是什么配置，以及最近 24 小时它悄悄降级了什么。
 *
 * 凭证在这里只出现两种形态：「已配置」或「未配置」。端点与备注都是自由文本，
 * 渲染前再过一遍 redactSecrets——Rust 侧已经剥过一次，这是 fail-closed 的第二道闸
 * （README.md 安全边界）。
 */
import type { ReactNode } from 'react';
import { Badge, CodeBlock, SectionHeader, StatusDot } from '../../../components';
import { cx, formatCount, formatRelative, formatTime, formatTokens, redactSecrets } from '../../../lib';
import { SEVERITY_LABEL, lookupDegrade } from '../../../data/degradeCatalog';
import type { Channel, LaunchResult, UsageRow } from '../../../types/contract';
import AliasEditor from './AliasEditor';
import OverrideEditor from './OverrideEditor';
import {
  API_FORMAT_NOTE,
  API_FORMAT_TONE,
  COMPATIBILITY_LABEL,
  COMPATIBILITY_TONE,
  INCOMPATIBLE_LAUNCH_NOTE,
  SEVERITY_TONE,
  SLOT_ORDER,
  UNASSESSED_EXPLAINER,
  WINDOW_SECONDS,
  channelWindow,
  safeEndpoint,
  type ChannelActions,
} from '../model';
import styles from './ChannelDetail.module.css';

export interface ChannelDetailProps {
  channel: Channel;
  actions: ChannelActions;
  recentUsage: UsageRow[];
  usageError: string | null;
  launchResult: LaunchResult | null;
  rowError: string | null;
}

export default function ChannelDetail({
  channel,
  actions,
  recentUsage,
  usageError,
  launchResult,
  rowError,
}: ChannelDetailProps) {
  const now = Math.floor(Date.now() / 1000);
  const win = channelWindow(recentUsage, channel, now);
  const endpoint = safeEndpoint(channel.endpoint);
  const notes = redactSecrets(channel.notes);
  const truncated = win.oldestTs !== null && win.oldestTs > now - WINDOW_SECONDS;

  return (
    <div className={styles.detail}>
      {rowError === null ? null : (
        <p className={styles.error} role="alert">
          {rowError}
        </p>
      )}

      {launchResult === null ? null : (
        <div className={styles.launch} aria-live="polite">
          <CodeBlock label="实际执行的命令" code={launchResult.command} />
          <p className={launchResult.ok ? styles.launchOk : styles.launchFail}>{launchResult.message}</p>
        </div>
      )}

      <div className={styles.columns}>
        <dl className={styles.facts}>
          <Fact label="渠道 id">
            <span className={styles.mono}>{channel.id}</span>
            <span className={styles.hint}>claude1 id:&lt;id&gt; 是精确选择器，同名渠道抢不走</span>
          </Fact>

          <Fact label="端点主机">
            {endpoint === null ? (
              <span className={styles.muted}>未配置 ANTHROPIC_BASE_URL</span>
            ) : (
              <span className={styles.mono}>{endpoint}</span>
            )}
          </Fact>

          <Fact label="凭证">
            <StatusDot tone={channel.credential === 'configured' ? 'ok' : 'fail'}>
              {channel.credential === 'configured' ? '已配置' : '未配置'}
            </StatusDot>
            <span className={styles.hint}>桌面端只知道有没有：凭证不进 IPC 响应，也不显示、不复制</span>
          </Fact>

          <Fact label="协议格式">
            <Badge tone={API_FORMAT_TONE[channel.apiFormat]}>{channel.apiFormat}</Badge>
            <span className={styles.hint}>{API_FORMAT_NOTE[channel.apiFormat]}</span>
          </Fact>

          <Fact label="语义兼容性">
            <StatusDot tone={COMPATIBILITY_TONE[channel.compatibility]}>
              {COMPATIBILITY_LABEL[channel.compatibility]}
            </StatusDot>
            {channel.compatibilityReason === null ? null : (
              <span className={styles.reason}>{channel.compatibilityReason}</span>
            )}
            {channel.compatibility === 'unassessed' ? (
              <span className={styles.hint}>{UNASSESSED_EXPLAINER}</span>
            ) : null}
            {channel.compatibility === 'incompatible' ? (
              <span className={styles.hint}>{INCOMPATIBLE_LAUNCH_NOTE}</span>
            ) : null}
          </Fact>

          <Fact label="上下文窗口">
            {channel.contextWindow === null ? (
              <span className={styles.muted}>未声明 claude1_capabilities.context_window</span>
            ) : (
              <span className={styles.mono}>{formatCount(channel.contextWindow)} token</span>
            )}
          </Fact>

          <Fact label="effort 档位">
            {channel.effortOverride === null ? (
              <span className={styles.muted}>未设置，由渠道自己的 effortLevel 决定</span>
            ) : (
              <Badge tone="violet">{channel.effortOverride}</Badge>
            )}
          </Fact>

          <Fact label="模型">
            {channel.declaredModel === null ? (
              <span className={styles.muted}>渠道未声明 env.ANTHROPIC_MODEL</span>
            ) : (
              <span className={styles.mono}>{channel.declaredModel}</span>
            )}
            {channel.modelOverride === null ? (
              <span className={styles.hint}>没有本地覆盖</span>
            ) : (
              <span className={styles.hint}>
                <span>本地覆盖成 </span>
                <span className={styles.mono}>{channel.modelOverride}</span>
              </span>
            )}
          </Fact>

          <Fact label="当前渠道">
            {channel.isCurrent ? (
              <StatusDot tone="current">是</StatusDot>
            ) : (
              <span className={styles.muted}>不是</span>
            )}
            <span className={styles.hint}>
              切换 CC Switch 的当前渠道要写数据库，本应用只读打开数据库，请到 CC Switch 里切换
            </span>
          </Fact>

          <Fact label="故障转移队列">
            {channel.inFailoverQueue ? (
              <span>在队列里</span>
            ) : (
              <span className={styles.muted}>不在队列里</span>
            )}
          </Fact>

          <Fact label="子代理模型">
            {channel.pinsSubagentModel ? (
              <>
                <StatusDot tone="degraded">被 settings_config 固定</StatusDot>
                <span className={styles.hint}>
                  env.CLAUDE_CODE_SUBAGENT_MODEL 写死了子代理模型，体检视图会建议清理
                </span>
              </>
            ) : (
              <span className={styles.muted}>未固定</span>
            )}
          </Fact>

          {channel.category === null ? null : <Fact label="分类">{channel.category}</Fact>}

          {notes === '' ? null : (
            <Fact label="备注">
              <span className={styles.notes}>{notes}</span>
            </Fact>
          )}

          <Fact label="最近一次使用">
            {channel.lastUsedAt === null ? (
              <span className={styles.muted}>还没用过（claude1-mru.json 里没有记录）</span>
            ) : (
              <span className={styles.mono}>
                {formatTime(channel.lastUsedAt)}（{formatRelative(channel.lastUsedAt, now)}）
              </span>
            )}
          </Fact>
        </dl>

        <div className={styles.side}>
          <section className={styles.block}>
            <SectionHeader
              level={3}
              title="模型槽位"
              subtitle="settings_config 声明的四个槽位默认模型，只读"
            />
            <ul className={styles.slots}>
              {SLOT_ORDER.map((slot) => {
                const model = channel.slotModels[slot];
                return (
                  <li key={slot} className={styles.slot}>
                    <span className={styles.slotName}>{slot}</span>
                    {model === undefined ? (
                      <span className={styles.muted}>未声明</span>
                    ) : (
                      <span className={styles.mono}>{model}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className={styles.block}>
            <SectionHeader
              level={3}
              title="最近 24 小时的降级码"
              subtitle="按 usage journal 的 channel 字段匹配渠道名、别名或 id"
            />
            {win.top.length === 0 ? (
              <p className={styles.muted}>{emptyDegradeReason(win.hasAnyRows, win.turns, usageError)}</p>
            ) : (
              <>
                <ul className={styles.degradeList}>
                  {win.top.map((item) => {
                    const entry = lookupDegrade(item.code);
                    return (
                      <li key={item.code} className={styles.degradeItem}>
                        <StatusDot
                          tone={SEVERITY_TONE[entry.severity]}
                          title={`${entry.what}\n影响：${entry.impact}\n建议：${entry.action}`}
                        >
                          {SEVERITY_LABEL[entry.severity]}
                        </StatusDot>
                        <span
                          className={cx(styles.degradeTitle, entry.severity === 'lossy' && styles.lossy)}
                        >
                          {entry.title}
                        </span>
                        <span className={styles.degradeCode}>{entry.code}</span>
                        <span className={styles.degradeCount}>{formatCount(item.count)} 次</span>
                      </li>
                    );
                  })}
                </ul>
                <p className={styles.hint}>
                  <span>窗口内 </span>
                  <span className={styles.mono}>{formatCount(win.turns)}</span>
                  <span> 个回合，其中 </span>
                  <span className={styles.mono}>{formatCount(win.degradedTurns)}</span>
                  <span> 个带降级。</span>
                </p>
              </>
            )}
            {win.turns === 0 ? null : (
              <p className={styles.hint}>
                <span>窗口内 token：输入 </span>
                <span className={styles.mono}>{formatTokens(win.inTokens)}</span>
                <span>、输出 </span>
                <span className={styles.mono}>{formatTokens(win.outTokens)}</span>
                <span>、缓存读 </span>
                <span className={styles.mono}>{formatTokens(win.cacheReadTokens)}</span>
                <span>。未配置价格表，不估算成本。</span>
              </p>
            )}
            {truncated && win.oldestTs !== null ? (
              <p className={styles.hint}>
                {`桌面端只读了最近若干条用量记录，最早一条是 ${formatTime(win.oldestTs)}；更早的 24 小时内容要去用量视图看。`}
              </p>
            ) : null}
          </section>
        </div>
      </div>

      <div className={styles.editors}>
        <AliasEditor channel={channel} onSave={(alias) => actions.setAlias(channel.id, alias)} />
        <OverrideEditor
          channel={channel}
          onSave={(model, effort) => actions.setOverride(channel.id, model, effort)}
        />
      </div>
    </div>
  );
}

interface FactProps {
  label: string;
  children: ReactNode;
}

function Fact({ label, children }: FactProps) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

/** 空的三种原因完全不同：还没读到用量、这个渠道没跑过、跑过但没降级 */
function emptyDegradeReason(hasAnyRows: boolean, turns: number, usageError: string | null): string {
  if (usageError !== null) return `用量记录读取失败：${usageError}`;
  if (!hasAnyRows) return '还没读到用量记录：在用量视图刷新一次，这里才会有数据。';
  if (turns === 0) return '最近 24 小时这个渠道没有回合记录。';
  return '最近 24 小时这个渠道的回合里没有降级记录。';
}
