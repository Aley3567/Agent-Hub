/** 渠道选择：名称、模型、历史记录与启动入口。配置放在展开详情。 */
import { useMemo, useState } from 'react';
import {
  EmptyState,
  Icon,
  SearchInput,
  Select,
  Spinner,
  Switch,
  Table,
  Td,
  Th,
  Toolbar,
} from '../../components';
import { useApp } from '../../store';
import type { Channel } from '../../types/contract';
import ChannelRow from './parts/ChannelRow';
import {
  FORMAT_FILTER_OPTIONS,
  asFormatFilter,
  isUsable,
  matchesQuery,
  type ChannelActions,
  type FormatFilter,
} from './model';
import styles from './index.module.css';

/** 表格总列数。展开的详情行与分区标题行都占「除末列以外」的全部列，末列留给 sticky 操作列 */
const COLUMN_COUNT = 4;

export default function ChannelsView() {
  const channels = useApp((state) => state.channels);
  const recentUsage = useApp((state) => state.recentUsage);
  const dbPath = useApp((state) => state.env?.dbPath ?? null);
  const loading = useApp((state) => state.loading.channels === true);
  const loaded = useApp((state) => state.loadedKeys.channels === true);
  const loadError = useApp((state) => state.error.channels ?? null);
  const usageError = useApp((state) => state.error.usage ?? null);
  const refresh = useApp((state) => state.refresh);
  const setHidden = useApp((state) => state.setHidden);
  const setAlias = useApp((state) => state.setAlias);
  const setOverride = useApp((state) => state.setOverride);
  const launch = useApp((state) => state.launch);

  const [query, setQuery] = useState('');
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');
  const [onlyUsable, setOnlyUsable] = useState(false);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [hiddenOpen, setHiddenOpen] = useState(false);

  const actions = useMemo<ChannelActions>(
    () => ({
      setHidden,
      setAlias,
      setOverride,
      launch: (id) => launch({ kind: 'channel', channelId: id }),
    }),
    [launch, setAlias, setHidden, setOverride],
  );

  const { visible, hiddenMatches } = useMemo(() => {
    const keep = (channel: Channel): boolean => {
      if (!matchesQuery(channel, query)) return false;
      if (formatFilter !== 'all' && channel.apiFormat !== formatFilter) return false;
      if (onlyUsable && !isUsable(channel)) return false;
      return true;
    };
    const sorted = [...channels].sort((a, b) => a.sortIndex - b.sortIndex);
    return {
      visible: sorted.filter((channel) => !channel.hidden && keep(channel)),
      hiddenMatches: sorted.filter((channel) => channel.hidden && keep(channel)),
    };
  }, [channels, formatFilter, onlyUsable, query]);

  const listed = useMemo(() => [...visible, ...hiddenMatches], [hiddenMatches, visible]);


  // 只剩隐藏项能匹配时强制展开，否则用户会看到一张空表加一个折叠分区，不知道东西在哪
  const forcedOpen = visible.length === 0;
  const hiddenExpanded = hiddenOpen || forcedOpen;

  function toggleExpanded(id: string, next: boolean): void {
    setExpanded((current) => {
      const has = current.includes(id);
      if (next === has) return current;
      return next ? [...current, id] : current.filter((item) => item !== id);
    });
  }

  function clearFilters(): void {
    setQuery('');
    setFormatFilter('all');
    setOnlyUsable(false);
  }

  const filterText = describeFilters(query, formatFilter, onlyUsable);

  return (
    <div className={styles.view}>
      {loading ? <div className="app-progress" role="progressbar" aria-label="正在读取渠道" /> : null}

      <Toolbar
        className={styles.toolbar}
        divider
        wrap={false}
        aria-label="渠道筛选"
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索渠道名、别名或模型"
          aria-label="按渠道名、别名或模型搜索"
        />
        <Select
          wrapperClassName={styles.protocolSelect}
          selectSize="sm"
          mono
          aria-label="按协议格式筛选"
          value={formatFilter}
          options={FORMAT_FILTER_OPTIONS}
          onChange={(event) => setFormatFilter(asFormatFilter(event.target.value))}
        />
        <Switch
          checked={onlyUsable}
          onChange={setOnlyUsable}
          label="只看配置就绪"
          aria-label="凭证已配置、未隐藏、未判为不兼容；不代表已通过网络测试"
        />
      </Toolbar>

      {loadError === null || channels.length === 0 ? null : (
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      )}

      {channels.length === 0 ? (
        <EmptyPlaceholder
          loading={loading}
          loaded={loaded}
          loadError={loadError}
          dbPath={dbPath}
          onRetry={() => void refresh('channels')}
        />
      ) : listed.length === 0 ? (
        <EmptyState
          icon="filter"
          title={`筛选条件排除了全部 ${channels.length} 个渠道`}
          description={`当前条件：${filterText}。放宽条件或清空筛选就能看到它们。`}
          action={{ label: '清空筛选', icon: 'close', onClick: clearFilters }}
        />
      ) : (
        <Table className={styles.channelTable} stickyHeader aria-label="渠道列表">
          <colgroup>
            <col />
            <col className={styles.colModel} />
            <col className={styles.colRecent} />
            <col className={styles.colAction} />
          </colgroup>
          <thead>
            <tr>
              <Th>渠道</Th>
              <Th>模型</Th>
              <Th>最近记录</Th>
              <Th stickyAction>操作</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                actions={actions}
                recentUsage={recentUsage}
                usageError={usageError}
                columnCount={COLUMN_COUNT}
                expanded={expanded.includes(channel.id)}
                onSetExpanded={toggleExpanded}
              />
            ))}
          </tbody>
          {hiddenMatches.length === 0 ? null : (
            <tbody>
              <tr className={styles.groupRow}>
                <td className={styles.groupCell} colSpan={COLUMN_COUNT - 1}>
                  <button
                    type="button"
                    className={styles.groupToggle}
                    aria-expanded={hiddenExpanded}
                    disabled={forcedOpen}
                    title={forcedOpen ? '其余渠道都被筛选条件排除了，隐藏分区保持展开' : undefined}
                    onClick={() => setHiddenOpen(!hiddenExpanded)}
                  >
                    {/* 方向靠 CSS 旋转而不是换图标名：图标名互换是硬切，拿不到 --dur-fast
                        那一档「图标旋转翻转」的过渡（DESIGN.md 2.5 时长语义表）。
                        chevron-right 转 90° 与 chevron-down 逐点相同，静态形态不变。 */}
                    <Icon name="chevron-right" size={16} className={styles.groupChevron} />
                    <span>
                      已隐藏（<span className={styles.groupCount}>{hiddenMatches.length}</span>）
                    </span>
                  </button>
                  <span className={styles.groupNote}>
                    隐藏只是让 claude1 的普通列表不列出它们，别名与 id 仍然能启动。
                  </span>
                </td>
                {/* 末列补一个空的 sticky 单元格：这一行原来 colSpan 铺满七列，横滚时分区
                    文字会从 sticky 操作列底下穿过去 */}
                <Td stickyAction className={styles.groupActionCell} />
              </tr>
              {hiddenExpanded
                ? hiddenMatches.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      actions={actions}
                      recentUsage={recentUsage}
                      usageError={usageError}
                      columnCount={COLUMN_COUNT}
                      expanded={expanded.includes(channel.id)}
                      onSetExpanded={toggleExpanded}
                    />
                  ))
                : null}
            </tbody>
          )}
        </Table>
      )}

      {listed.length === 0 ? null : (
        <p className={styles.note}>启动会话将在新终端中打开。最近记录仅反映历史调用，未进行主动测活。</p>
      )}
    </div>
  );
}

interface EmptyPlaceholderProps {
  loading: boolean;
  /** channels 是否至少加载过一次（成败都算）。首帧 loading 还没置真，靠它压住空态闪烁 */
  loaded: boolean;
  loadError: string | null;
  /** env 没给 dbPath 时是 null：不猜默认路径，只说没检测到 */
  dbPath: string | null;
  onRetry: () => void;
}

/** 一个渠道都没有时的三种处境：还在读、读失败、真的没有。三种下一步不一样 */
function EmptyPlaceholder({ loading, loaded, loadError, dbPath, onRetry }: EmptyPlaceholderProps) {
  if (loading || !loaded) {
    return (
      <p className={styles.pending}>
        <Spinner label="正在读取 Hub 渠道列表" />
      </p>
    );
  }
  if (loadError !== null) {
    return (
      <EmptyState
        icon="error"
        title="没能读到渠道列表"
        description={loadError}
        action={{ label: '重试', icon: 'refresh', onClick: onRetry }}
        hint={
          dbPath === null ? (
            <span>数据库路径没有检测到，无法确认读的是哪个文件</span>
          ) : (
            <span className={styles.mono}>{dbPath}</span>
          )
        }
      />
    );
  }
  return (
    <EmptyState
      hero
      title="还没有 Claude 渠道"
      description="还没有可用的 Claude 渠道。请运行 agent-hub 添加或导入渠道，然后回到这里刷新。"
      action={{ label: '刷新', icon: 'refresh', onClick: onRetry }}
      hint={
        dbPath === null ? (
          <span>未检测到渠道库路径，请检查 Agent Hub 配置</span>
        ) : (
          <span>
            只读打开：<span className={styles.mono}>{dbPath}</span>
          </span>
        )
      }
    />
  );
}

function describeFilters(query: string, formatFilter: FormatFilter, onlyUsable: boolean): string {
  const parts: string[] = [];
  const trimmed = query.trim();
  if (trimmed !== '') parts.push(`搜索「${trimmed}」`);
  if (formatFilter !== 'all') parts.push(`协议格式 ${formatFilter}`);
  if (onlyUsable) parts.push('只看配置就绪');
  return parts.length === 0 ? '没有任何筛选' : parts.join('、');
}
