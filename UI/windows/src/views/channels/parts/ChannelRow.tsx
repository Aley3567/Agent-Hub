import { channelKey } from '../../../types/contract';
/**
 * 渠道表格的一行，外加它展开后的详情行。
 *
 * 行内动作的错误一律留在本行里显示：store 的 error 是按动作名存的全局键，
 * 六行同时报错会互相覆盖，所以每行自己记原因，并在出错时把详情强制展开——
 * 折叠状态下报错等于没报（AGENTS.md：错误原样暴露）。
 */
import { useId, useState } from 'react';
import { Badge, Button, Icon, MidTruncate, StatusDot, Td } from '../../../components';
import { cx, formatTime } from '../../../lib';
import { errorText } from '../../../store';
import { useToast } from '../../../store/toast';
import type { Channel, LaunchResult, UsageRow } from '../../../types/contract';
import ChannelDetail from './ChannelDetail';
import {
  channelModel,
  channelStatuses,
  type ChannelActions,
} from '../model';
import styles from './ChannelRow.module.css';

export interface ChannelRowProps {
  channel: Channel;
  actions: ChannelActions;
  recentUsage: UsageRow[];
  usageError: string | null;
  /** 表格总列数。详情行占前 columnCount - 1 列，末列留给 sticky 操作列 */
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
  // 启动反馈统一走 toast（REDESIGN-PROMPT 2.3.5）：成功一条、失败把原文再推一条。
  // 详情面板里的命令回显与错误原文保留——toast 3 秒就消失，命令与原因得留得住
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);

  const statuses = channelStatuses(channel);
  const model = channelModel(channel);
  const incompatible = channel.compatibility === 'incompatible';
  // 只使用稳定 provider 身份匹配；同名渠道和旧别名记录不能互相认领。
  const latest = recentUsage
    .filter((row) => 'providerId' in row && row.providerId === channel.id && 'providerApp' in row && row.providerApp === channel.appType)
    .reduce<UsageRow | null>((last, row) => last === null || row.ts > last.ts ? row : last, null);

  async function runLaunch(): Promise<void> {
    setBusy('launch');
    setRowError(null);
    setLaunchResult(null);
    onSetExpanded(channelKey(channel), true);
    try {
      const result = await actions.launch(channel.id, channel.appType);
      setLaunchResult(result);
      // ok 为 false 也要留痕：失败绝不伪装成成功
      if (result.ok) {
        toastSuccess(`已启动 ${channel.name} 的会话`);
      } else {
        setRowError(result.message);
        toastError(result.message);
      }
    } catch (cause) {
      const reason = errorText(cause);
      setRowError(reason);
      toastError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function toggleHidden(): Promise<void> {
    setBusy('hidden');
    setRowError(null);
    try {
      await actions.setHidden(channel.id, !channel.hidden, channel.appType);
    } catch (cause) {
      setRowError(errorText(cause));
      onSetExpanded(channelKey(channel), true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <tr className={cx(channel.isCurrent && styles.currentRow, channel.hidden && styles.hiddenRow)}>
        <Td className={cx(styles.statusCell, channel.isCurrent && styles.currentCell)}>
          <span className={styles.nameCell}>
            <button
              type="button"
              className={styles.nameButton}
              aria-expanded={expanded}
              aria-controls={detailId}
              title={expanded ? '收起渠道详情' : '展开渠道详情'}
              onClick={() => onSetExpanded(channelKey(channel), !expanded)}
            >
              {/* 方向靠 CSS 旋转而不是换图标名：图标名互换是硬切，拿不到 --dur-fast
                  那一档「图标旋转翻转」的过渡（DESIGN.md 2.5 时长语义表）。
                  chevron-right 转 90° 与 chevron-down 逐点相同，静态形态不变。 */}
              <Icon name="chevron-right" size={16} className={styles.nameChevron} />
              <span className={styles.nameText} title={channel.name}>
                {channel.name}
              </span>
            </button>
            {channel.alias === null ? null : (
              <Badge
                className={styles.cellBadge}
                tone="accent"
                title={`别名：可以直接 claude1 ${channel.alias} 启动`}
              >
                {channel.alias}
              </Badge>
            )}
          </span>
          <span className={styles.statusStack}>
            {statuses.map((status) => (
              <StatusDot key={status.text} tone={status.tone} title={status.title}>{status.text}</StatusDot>
            ))}
          </span>
        </Td>
        <Td className={styles.modelCell}>
          {/* title 只挂一层。标识符分支交给 MidTruncate——它的 title 盖在最内层，
              外层再挂一个的话浏览器只显示内层，来源说明就永远看不到了，所以两段合成一条。 */}
          <span className={styles.modelInner} title={model.isIdentifier ? undefined : model.title}>
            {model.isIdentifier ? (
              /* DESIGN.md 4.1.1「模型名列：240px 上限 + 中截断」：尾部留 8 位，
                 claude-opus-4-1-20250805 的 20250805 必须可见。title 里第一行是完整 id，
                 第二行是来源说明；MidTruncate 会把整段过一遍 redactSecrets */
              <MidTruncate
                className={styles.mono}
                value={model.text}
                tail={8}
                title={`${model.text}\n${model.title}`}
              />
            ) : (
              /* 「未指定」是一句中文说明而不是标识符，不上等宽也不用截断 */
              <span className={styles.muted}>{model.text}</span>
            )}
            {model.overridden ? (
              <Badge
                className={styles.cellBadge}
                tone="violet"
                mono={false}
                title="本地覆盖，写在 claude1-config.json，不动数据库"
              >
                覆盖
              </Badge>
            ) : null}
            {channel.effortOverride === null ? null : (
              <Badge
                className={styles.cellBadge}
                tone="violet"
                title={`本地覆盖 effortLevel 为 ${channel.effortOverride}`}
              >
                {channel.effortOverride}
              </Badge>
            )}
          </span>
        </Td>

        <Td>
          <span className={styles.recent} title={usageError ?? '当前载入记录中最近的一条；不代表当前配置可用或请求完整成功'}>
            {usageError !== null ? '记录读取失败' : latest === null ? '暂无记录' : formatTime(latest.ts)}
            {latest === null ? null : <span className={styles.muted}>{latest.model}</span>}
          </span>
        </Td>

        <Td stickyAction currentRow={channel.isCurrent} className={styles.actionCell}>
          <span className={styles.actionsCell}>
            <Button
              size="sm"
              icon="play"
              loading={busy === 'launch'}
              disabled={busy === 'hidden'}
              onClick={() => void runLaunch()}
              aria-label={`启动 ${channel.name} 的会话`}
              title={
                incompatible
                  ? '启动会话：新终端窗口执行 claude1 id:<渠道 id>。该渠道被判为不兼容，这条路径只用于诊断'
                  : '启动会话：新终端窗口执行 claude1 id:<渠道 id>'
              }
            >启动会话</Button>
            <Button
              size="sm"
              aria-label={`更多：${channel.name}`}
              aria-expanded={expanded}
              aria-controls={detailId}
              onClick={() => onSetExpanded(channelKey(channel), !expanded)}
            >更多</Button>
          </span>
        </Td>
      </tr>

      {expanded ? (
        <tr>
          <td className={styles.detailCell} colSpan={columnCount - 1} id={detailId}>
            <Button
              size="sm"
              icon={channel.hidden ? 'eye' : 'eye-off'}
              loading={busy === 'hidden'}
              disabled={busy !== null || channel.appType !== 'claude'}
              onClick={() => void toggleHidden()}
            >{channel.hidden ? '取消隐藏' : '隐藏渠道'}</Button>
            <Button size="sm" onClick={() => actions.manage(channel, 'edit')}>编辑渠道</Button>
            <Button size="sm" onClick={() => actions.manage(channel, 'delete')}>删除渠道</Button>
            <ChannelDetail
              channel={channel}
              actions={actions}
              recentUsage={recentUsage}
              usageError={usageError}
              launchResult={launchResult}
              rowError={rowError}
            />
          </td>
          {/* 详情面板原来 colSpan 铺满七列，右端正好落在 sticky 操作列的位置上，而这一行自己
              没有 sticky 单元格：横滚时面板文字会从操作列底下穿过去。补一个同色的空单元格 */}
          <Td stickyAction className={styles.detailActionCell} />
        </tr>
      ) : null}
    </>
  );
}
