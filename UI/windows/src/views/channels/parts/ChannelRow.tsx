/**
 * 渠道表格的一行，外加它展开后的详情行。
 *
 * 行内动作的错误一律留在本行里显示：store 的 error 是按动作名存的全局键，
 * 六行同时报错会互相覆盖，所以每行自己记原因，并在出错时把详情强制展开——
 * 折叠状态下报错等于没报（AGENTS.md：错误原样暴露）。
 */
import { useId, useState } from 'react';
import { Badge, Button, IconButton, Icon, MidTruncate, StatusDot, Td } from '../../../components';
import { MISSING, cx, formatTokens, redactSecrets } from '../../../lib';
import { errorText } from '../../../store';
import { useToast } from '../../../store/toast';
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
  /* 语义兼容性列占 DESIGN.md 4.1.1「备注列：min 160 / max 320，两行截断」那一档预算：
     两行截断后完整文本进 title，而显示串与 title 两份文本都得先过 redactSecrets
     （CONTRACT.md 1.2 凭证脱敏（fail-closed）），不能因为「只是 tooltip」就绕过。 */
  const compatReason = redactSecrets(channel.compatibilityReason).trim();

  async function runLaunch(): Promise<void> {
    setBusy('launch');
    setRowError(null);
    setLaunchResult(null);
    onSetExpanded(channel.id, true);
    try {
      const result = await actions.launch(channel.id);
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
              {/* 方向靠 CSS 旋转而不是换图标名：图标名互换是硬切，拿不到 --dur-fast
                  那一档「图标旋转翻转」的过渡（DESIGN.md 2.5 时长语义表）。
                  chevron-right 转 90° 与 chevron-down 逐点相同，静态形态不变。 */}
              <Icon name="chevron-right" size={16} className={styles.nameChevron} />
              {/* 渠道列定宽 150px：长名字单行截断，完整名进 title（title 里的串与显示的是
                  同一个值，没有引入新的上游文本）。这里刻意不用中截断——名字的辨识度在头部，
                  而 DESIGN.md 4.1.1「模型名列：240px 上限 + 中截断」保尾部是为了日期戳；
                  实测 150px 的格子里还要放别名 Badge，中截断会把头段压到 0px，只剩尾巴 */}
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
        </Td>

        <Td>
          <Badge
            className={styles.formatBadge}
            tone={API_FORMAT_TONE[channel.apiFormat]}
            title={API_FORMAT_NOTE[channel.apiFormat]}
          >
            {channel.apiFormat}
          </Badge>
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

        <Td className={styles.compatCell}>
          <span className={styles.compatInner}>
            <StatusDot
              className={styles.compatDot}
              tone={COMPATIBILITY_TONE[channel.compatibility]}
              title={
                channel.compatibility === 'unassessed'
                  ? '展开详情看这一档的含义'
                  : `Claude Code 语义闸门结论：${COMPATIBILITY_LABEL[channel.compatibility]}`
              }
            >
              {COMPATIBILITY_LABEL[channel.compatibility]}
            </StatusDot>
            {compatReason === '' ? null : (
              <span className={styles.compatReasonBox}>
                <span
                  className={incompatible ? styles.compatReasonBad : styles.compatReason}
                  title={compatReason}
                >
                  {compatReason}
                </span>
              </span>
            )}
          </span>
        </Td>

        {/* sticky 操作列全部交给原语（DESIGN.md 4.1.1「sticky 操作列」）：当前行必须显式传
            currentRow，底色才换成不透明的 --bg-selected-table-solid。视图只留 .actionCell
            改已隐藏行的底色变量，不再有第二套 position: sticky */}
        <Td stickyAction currentRow={channel.isCurrent} className={styles.actionCell}>
          <span className={styles.actionsCell}>
            {/* 动作列的硬预算是 132px（DESIGN.md 4.1.1「宽度预算」，扣掉左右 --sp-3 只剩 108px；
                分隔线是 inset box-shadow、不占盒宽，所以不用再扣 1px），
                下面三个控件实测正好 107px（31 + 8 + 30 + 8 + 30），**余量只有 1px**——
                动 gap 或 padding 之前先重算，溢出会被 sticky 列的滚动容器直接裁掉，
                带「启动会话」四个字的按钮加两个 IconButton 实测要 171px，装不进去：末列 sticky，
                溢出的部分会被滚动容器裁掉，隐藏与编辑两个按钮在 1440px 下就点不到了。
                这里只去掉可见文字，组件、loading 态与点击行为都不动，文案落到 aria-label 与
                title 上——预算是别人的文件里的 token，不能在视图里自己加宽。 */}
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
            />
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
          <td className={styles.detailCell} colSpan={columnCount - 1} id={detailId}>
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
