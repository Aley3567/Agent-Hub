/**
 * 渠道表格的一行，外加它展开后的详情行。
 *
 * 行内动作的错误一律留在本行里显示：store 的 error 是按动作名存的全局键，
 * 六行同时报错会互相覆盖，所以每行自己记原因，并在出错时把详情强制展开——
 * 折叠状态下报错等于没报（AGENTS.md：错误原样暴露）。
 */
import { useId, useState } from 'react';
import { Badge, Button, IconButton, Icon, StatusDot, Td } from '../../../components';
import { MISSING, cx, formatTokens } from '../../../lib';
import { errorText } from '../../../store';
import type { Channel, LaunchResult, UsageRow } from '../../../types/contract';
import ChannelDetail from './ChannelDetail';
import {
  API_FORMAT_NOTE,
  API_FORMAT_TONE,
  COMPATIBILITY_LABEL,
  COMPATIBILITY_TONE,
  CONTEXT_WINDOW_UNKNOWN_TITLE,
  channelModel,
  channelStatuses,
  contextWindowTitle,
  type ChannelActions,
} from '../model';
import styles from './ChannelRow.module.css';

export interface ChannelRowProps {
  channel: Channel;
  actions: ChannelActions;
  recentUsage: UsageRow[];
  usageError: string | null;
  /** 详情行的 colSpan */
  columnCount: number;
  expanded: boolean;
  onSetExpanded(id: string, next: boolean): void;
}

type Busy = 'launch' | 'hidden' | null;

export default function ChannelRow({
  channel,
  actions,
  recentUsage,
  usageError,
  columnCount,
  expanded,
  onSetExpanded,
}: ChannelRowProps) {
  const detailId = useId();
  const [busy, setBusy] = useState<Busy>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);

  const statuses = channelStatuses(channel);
  const model = channelModel(channel);
  const incompatible = channel.compatibility === 'incompatible';

  async function runLaunch(): Promise<void> {
    setBusy('launch');
    setRowError(null);
    setLaunchResult(null);
    onSetExpanded(channel.id, true);
    try {
      const result = await actions.launch(channel.id);
      setLaunchResult(result);
      // ok 为 false 也要留痕：失败绝不伪装成成功
      if (!result.ok) setRowError(result.message);
    } catch (cause) {
      setRowError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }

  async function toggleHidden(): Promise<void> {
    setBusy('hidden');
    setRowError(null);
    try {
      await actions.setHidden(channel.id, !channel.hidden);
    } catch (cause) {
      setRowError(errorText(cause));
      onSetExpanded(channel.id, true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <tr className={cx(channel.isCurrent && styles.currentRow, channel.hidden && styles.hiddenRow)}>
        <Td className={cx(styles.statusCell, channel.isCurrent && styles.currentCell)}>
          <span className={styles.statusStack}>
            {statuses.map((status) => (
              <StatusDot key={status.text} tone={status.tone} title={status.title}>
                {status.text}
              </StatusDot>
            ))}
          </span>
        </Td>

        <Td>
          <span className={styles.nameCell}>
            <button
              type="button"
              className={styles.nameButton}
              aria-expanded={expanded}
              aria-controls={detailId}
              title={expanded ? '收起渠道详情' : '展开渠道详情'}
              onClick={() => onSetExpanded(channel.id, !expanded)}
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
              <span className={styles.nameText}>{channel.name}</span>
            </button>
            {channel.alias === null ? null : (
              <Badge tone="accent" title={`别名：可以直接 claude1 ${channel.alias} 启动`}>
                {channel.alias}
              </Badge>
            )}
          </span>
        </Td>

        <Td>
          <Badge tone={API_FORMAT_TONE[channel.apiFormat]} title={API_FORMAT_NOTE[channel.apiFormat]}>
            {channel.apiFormat}
          </Badge>
        </Td>

        <Td>
          <span className={styles.modelCell} title={model.title}>
            <span className={model.isIdentifier ? styles.mono : styles.muted}>{model.text}</span>
            {model.overridden ? (
              <Badge tone="violet" mono={false} title="本地覆盖，写在 claude1-config.json，不动数据库">
                覆盖
              </Badge>
            ) : null}
            {channel.effortOverride === null ? null : (
              <Badge tone="violet" title={`本地覆盖 effortLevel 为 ${channel.effortOverride}`}>
                {channel.effortOverride}
              </Badge>
            )}
          </span>
        </Td>

        <Td
          numeric
          title={
            channel.contextWindow === null
              ? CONTEXT_WINDOW_UNKNOWN_TITLE
              : contextWindowTitle(channel.contextWindow)
          }
        >
          {channel.contextWindow === null ? MISSING : formatTokens(channel.contextWindow)}
        </Td>

        <Td>
          <span className={styles.compatCell}>
            <StatusDot
              tone={COMPATIBILITY_TONE[channel.compatibility]}
              title={
                channel.compatibility === 'unassessed'
                  ? '展开详情看这一档的含义'
                  : `Claude Code 语义闸门结论：${COMPATIBILITY_LABEL[channel.compatibility]}`
              }
            >
              {COMPATIBILITY_LABEL[channel.compatibility]}
            </StatusDot>
            {channel.compatibilityReason === null ? null : (
              <span className={incompatible ? styles.compatReasonBad : styles.compatReason}>
                {channel.compatibilityReason}
              </span>
            )}
          </span>
        </Td>

        <Td>
          <span className={styles.actionsCell}>
            <Button
              size="sm"
              icon="play"
              loading={busy === 'launch'}
              disabled={busy === 'hidden'}
              onClick={() => void runLaunch()}
              title={
                incompatible
                  ? '启动会话：新终端窗口执行 claude1 id:<渠道 id>。该渠道被判为不兼容，这条路径只用于诊断'
                  : '启动会话：新终端窗口执行 claude1 id:<渠道 id>'
              }
            >
              启动会话
            </Button>
            <IconButton
              icon={channel.hidden ? 'eye' : 'eye-off'}
              aria-label={channel.hidden ? `取消隐藏 ${channel.name}` : `隐藏 ${channel.name}`}
              tooltip={channel.hidden ? '取消隐藏' : '隐藏：普通列表不再列出它'}
              disabled={busy !== null}
              onClick={() => void toggleHidden()}
            />
            <IconButton
              icon="edit"
              aria-label={`编辑 ${channel.name} 的别名与覆盖`}
              tooltip="改别名、覆盖模型与 effort"
              active={expanded}
              onClick={() => onSetExpanded(channel.id, !expanded)}
            />
          </span>
        </Td>
      </tr>

      {expanded ? (
        <tr>
          <td className={styles.detailCell} colSpan={columnCount} id={detailId}>
            <ChannelDetail
              channel={channel}
              actions={actions}
              recentUsage={recentUsage}
              usageError={usageError}
              launchResult={launchResult}
              rowError={rowError}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
