/**
 * 渠道视图：哪些渠道可用、各自说什么协议、这次用哪个。
 *
 * 标题与副标题由外壳的 ViewHeader 按 CONTRACT.md 第 6.5 节的文案锚点渲染，本视图不再重复一遍。
 *
 * 这一页要回答的问题决定了列的顺序：先看能不能用（状态点），再看是谁（渠道名与别名），
 * 再看说什么协议（跨协议就会降级），然后才是模型、上下文窗口与语义兼容性。
 * 隐藏的渠道折到最底下的分区里——它们仍然可以用别名和 id 启动，所以不能真的藏掉。
 */
import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  Icon,
  SearchInput,
  Select,
  Spinner,
  Switch,
  Table,
  Th,
  Toolbar,
  Tooltip,
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

/** 表头列数，展开行与分区行的 colSpan 要跟着它 */
const COLUMN_COUNT = 7;

const DEFAULT_DB_PATH = '~/.cc-switch/cc-switch.db';

export default function ChannelsView() {
  const channels = useApp((state) => state.channels);
  const recentUsage = useApp((state) => state.recentUsage);
  const dbPath = useApp((state) => state.env?.dbPath ?? null);
  const loading = useApp((state) => state.loading.channels === true);
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
        divider
        aria-label="渠道筛选"
        right={
          <Button
            size="sm"
            icon="refresh"
            loading={loading}
            onClick={() => void refresh('channels')}
            title="重新读取 CC Switch 的 providers 表与本地覆盖"
          >
            刷新
          </Button>
        }
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索渠道名、别名或模型"
          aria-label="按渠道名、别名或模型搜索"
        />
        <Select
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
          label="只看可用"
          aria-label="只看可用渠道：凭证已配置、未隐藏、未判为不兼容"
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
          loadError={loadError}
          dbPath={dbPath ?? DEFAULT_DB_PATH}
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
        <Table stickyHeader aria-label="渠道列表">
          <thead>
            <tr>
              <Th>状态</Th>
              <Th>渠道</Th>
              <Th>
                <Tooltip content="anthropic 是原生直通；openai_chat / openai_responses 需要协议转换，会记 HUB_DEGRADE_* 降级；unknown 是解析不出协议格式。">
                  <span>协议格式</span>
                </Tooltip>
              </Th>
              <Th>模型</Th>
              <Th numeric>上下文窗口</Th>
              <Th>
                <Tooltip content="Claude Code 语义闸门结论：已验收 / 不兼容 / 未评估（没人验过，不是不能用）。">
                  <span>语义兼容性</span>
                </Tooltip>
              </Th>
              <Th>动作</Th>
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
                <td className={styles.groupCell} colSpan={COLUMN_COUNT}>
                  <button
                    type="button"
                    className={styles.groupToggle}
                    aria-expanded={hiddenExpanded}
                    disabled={forcedOpen}
                    title={forcedOpen ? '其余渠道都被筛选条件排除了，隐藏分区保持展开' : undefined}
                    onClick={() => setHiddenOpen(!hiddenExpanded)}
                  >
                    <Icon name={hiddenExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                    <span>
                      已隐藏（<span className={styles.groupCount}>{hiddenMatches.length}</span>）
                    </span>
                  </button>
                  <span className={styles.groupNote}>
                    隐藏只是让 claude1 的普通列表不列出它们，别名与 id 仍然能启动。
                  </span>
                </td>
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
        <div className={styles.notes}>
          <p className={styles.note}>
            <span>「启动会话」会在新的终端窗口执行 </span>
            <span className={styles.mono}>claude1 id:&lt;渠道 id&gt;</span>
            <span>，会话由终端里的 claude1 接管，桌面端不代管进程。</span>
          </p>
        </div>
      )}
    </div>
  );
}

interface EmptyPlaceholderProps {
  loading: boolean;
  loadError: string | null;
  dbPath: string;
  onRetry: () => void;
}

/** 一个渠道都没有时的三种处境：还在读、读失败、真的没有。三种下一步不一样 */
function EmptyPlaceholder({ loading, loadError, dbPath, onRetry }: EmptyPlaceholderProps) {
  if (loading) {
    return (
      <p className={styles.pending}>
        <Spinner label="正在读取 CC Switch 的渠道列表" />
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
        hint={<span className={styles.mono}>{dbPath}</span>}
      />
    );
  }
  return (
    <EmptyState
      hero
      title="还没有 Claude 渠道"
      description="数据库的 providers 表里没有 app_type='claude' 的记录。先在 CC Switch 里添加一个 Claude 渠道，再回到这里刷新。"
      action={{ label: '刷新', icon: 'refresh', onClick: onRetry }}
      hint={
        <span>
          只读打开：<span className={styles.mono}>{dbPath}</span>
        </span>
      }
    />
  );
}

function describeFilters(query: string, formatFilter: FormatFilter, onlyUsable: boolean): string {
  const parts: string[] = [];
  const trimmed = query.trim();
  if (trimmed !== '') parts.push(`搜索「${trimmed}」`);
  if (formatFilter !== 'all') parts.push(`协议格式 ${formatFilter}`);
  if (onlyUsable) parts.push('只看可用');
  return parts.length === 0 ? '没有任何筛选' : parts.join('、');
}
