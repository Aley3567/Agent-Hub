/**
 * 展开行的详情面板：这个渠道到底是什么配置，以及最近 24 小时它悄悄降级了什么。
 *
 * 凭证在这里只出现两种形态：「已配置」或「未配置」。端点与备注都是自由文本，
 * 渲染前再过一遍 redactSecrets——Rust 侧已经剥过一次，这是 fail-closed 的第二道闸
 * （README.md 安全边界）。
 */
import { t } from '../../../i18n';
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
          <CodeBlock label={t("实际执行的命令")} code={launchResult.command} />
          <p className={launchResult.ok ? styles.launchOk : styles.launchFail}>{t(launchResult.message)}</p>
        </div>
      )}

      <div className={styles.columns}>
        <dl className={styles.facts}>
          <Fact label={t("渠道 id")}>
            <span className={styles.mono}>{channel.id}</span>
            <span className={styles.hint}>{t("按应用和渠道 ID 精确启动，不会被同名渠道覆盖")}</span>
          </Fact>

          <Fact label={t("端点主机")}>
            {endpoint === null ? (
              <span className={styles.muted}>{t("未配置 ANTHROPIC_BASE_URL")}</span>
            ) : (
              <span className={styles.mono}>{endpoint}</span>
            )}
          </Fact>

          <Fact label={t("凭证")}>
            <StatusDot tone={channel.credential === 'configured' ? 'ok' : 'fail'}>
              {channel.credential === 'configured' ? t("已配置") : t("未配置")}
            </StatusDot>
            <span className={styles.hint}>{t("桌面端只知道有没有：凭证不进 IPC 响应，也不显示、不复制")}</span>
          </Fact>

          <Fact label={t("协议格式")}>
            <Badge tone={API_FORMAT_TONE[channel.apiFormat]}>{channel.apiFormat}</Badge>
            <span className={styles.hint}>{t(API_FORMAT_NOTE[channel.apiFormat])}</span>
          </Fact>

          <Fact label={t("语义兼容性")}>
            <StatusDot tone={COMPATIBILITY_TONE[channel.compatibility]}>
              {t(COMPATIBILITY_LABEL[channel.compatibility])}
            </StatusDot>
            {channel.compatibilityReason === null ? null : (
              <span className={styles.reason}>{t(redactSecrets(channel.compatibilityReason))}</span>
            )}
            {channel.compatibility === 'unassessed' ? (
              <span className={styles.hint}>{t(UNASSESSED_EXPLAINER)}</span>
            ) : null}
            {channel.compatibility === 'incompatible' ? (
              <span className={styles.hint}>{t(INCOMPATIBLE_LAUNCH_NOTE)}</span>
            ) : null}
          </Fact>

          <Fact label={t("上下文窗口")}>
            {channel.contextWindow === null ? (
              <span className={styles.muted}>{t("未声明 claude1_capabilities.context_window")}</span>
            ) : (
              <span className={styles.mono}>{formatCount(channel.contextWindow)} token</span>
            )}
          </Fact>

          <Fact label={t("effort 档位")}>
            {channel.effortOverride === null ? (
              <span className={styles.muted}>{t("未设置，由渠道自己的 effortLevel 决定")}</span>
            ) : (
              <Badge tone="violet">{channel.effortOverride}</Badge>
            )}
          </Fact>

          <Fact label={t("模型")}>
            {channel.declaredModel === null ? (
              <span className={styles.muted}>{t("渠道未声明 env.ANTHROPIC_MODEL")}</span>
            ) : (
              <span className={styles.mono}>{redactSecrets(channel.declaredModel)}</span>
            )}
            {channel.modelOverride === null ? (
              <span className={styles.hint}>{t("没有本地覆盖")}</span>
            ) : (
              <span className={styles.hint}>
                <span>{t("本地覆盖成")}</span>
                <span className={styles.mono}>{redactSecrets(channel.modelOverride)}</span>
              </span>
            )}
          </Fact>

          <Fact label={t("当前渠道")}>
            {channel.isCurrent ? (
              <StatusDot tone="current">{t("是")}</StatusDot>
            ) : (
              <span className={styles.muted}>{t("不是")}</span>
            )}
            <span className={styles.hint}>{t("桌面端不切换默认渠道；可按 ID 启动指定渠道")}</span>
          </Fact>

          <Fact label={t("故障转移队列")}>
            {channel.inFailoverQueue ? (
              <span>{t("在队列里")}</span>
            ) : (
              <span className={styles.muted}>{t("不在队列里")}</span>
            )}
          </Fact>

          <Fact label={t("子代理模型")}>
            {channel.pinsSubagentModel ? (
              <>
                <StatusDot tone="degraded">{t("被 settings_config 固定")}</StatusDot>
                <span className={styles.hint}>{t("env.CLAUDE_CODE_SUBAGENT_MODEL 写死了子代理模型，体检视图会建议清理")}</span>
              </>
            ) : (
              <span className={styles.muted}>{t("未固定")}</span>
            )}
          </Fact>

          {channel.category === null ? null : <Fact label={t("分类")}>{channel.category}</Fact>}

          {notes === '' ? null : (
            <Fact label={t("备注")}>
              <span className={styles.notes}>{notes}</span>
            </Fact>
          )}

          <Fact label={t("最近一次使用")}>
            {channel.lastUsedAt === null ? (
              <span className={styles.muted}>{t("还没用过（claude1-mru.json 里没有记录）")}</span>
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
              title={t("模型槽位")}
              subtitle={t("settings_config 声明的四个槽位默认模型，只读")}
            />
            <ul className={styles.slots}>
              {SLOT_ORDER.map((slot) => {
                const model = channel.slotModels[slot];
                return (
                  <li key={slot} className={styles.slot}>
                    <span className={styles.slotName}>{slot}</span>
                    {model === undefined ? (
                      <span className={styles.muted}>{t("未声明")}</span>
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
              title={t("最近 24 小时的降级码")}
              subtitle={t("按应用与渠道身份归属；旧 Claude 日志兼容名称与别名匹配")}
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
                          title={t("{0}\n影响：{1}\n建议：{2}", [entry.what, entry.impact, entry.action])}
                        >
                          {SEVERITY_LABEL[entry.severity]}
                        </StatusDot>
                        <span
                          className={cx(styles.degradeTitle, entry.severity === 'lossy' && styles.lossy)}
                        >
                          {entry.title}
                        </span>
                        <span className={styles.degradeCode}>{entry.code}</span>
                        <span className={styles.degradeCount}>{formatCount(item.count)}{t("次")}</span>
                      </li>
                    );
                  })}
                </ul>
                <p className={styles.hint}>
                  {t("窗口内 {0} 个回合，其中 {1} 个带降级。", [formatCount(win.turns), formatCount(win.degradedTurns)])}
                </p>
              </>
            )}
            {win.turns === 0 ? null : (
              <p className={styles.hint}>
                {t("窗口内 token：输入 {0}、输出 {1}、缓存读 {2}。未配置价格表，不估算成本。", [formatTokens(win.inTokens), formatTokens(win.outTokens), formatTokens(win.cacheReadTokens)])}
              </p>
            )}
            {truncated && win.oldestTs !== null ? (
              <p className={styles.hint}>
                {t("桌面端只读了最近若干条用量记录，最早一条是 {0}；更早的 24 小时内容要去用量视图看。", [formatTime(win.oldestTs)])}
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {channel.appType === 'claude' ? <div className={styles.editors}>
        <AliasEditor channel={channel} onSave={(alias) => actions.setAlias(channel.id, alias, channel.appType)} />
        <OverrideEditor
          channel={channel}
          onSave={(model, effort) => actions.setOverride(channel.id, model, effort, channel.appType)}
        />
      </div> : null}
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
  if (usageError !== null) return t("用量记录读取失败：{0}", [usageError]);
  if (!hasAnyRows) return t("还没读到用量记录：在用量视图刷新一次，这里才会有数据。");
  if (turns === 0) return t("最近 24 小时这个渠道没有回合记录。");
  return t("最近 24 小时这个渠道的回合里没有降级记录。");
}
