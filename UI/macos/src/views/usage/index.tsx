/**
 * 用量视图 —— 回答「token 花在哪儿、缓存命中多少、成本多少」。
 *
 * 三条自我约束：
 *   1. 不编造成本。costSource 为 null 时只给 token 量并把这件事说出来
 *      （绝不把 $0 当成真实成本）。
 *   2. 每个数字都标口径。输入含不含缓存读、成本来自哪个定价表，全部写在旁边——
 *      记账页里最贵的错误是让人按错误的口径下判断。
 *   3. 图与表的统计范围不同：上半页的聚合受时间窗限制，底部明细是流水最近 N 条、
 *      与时间窗无关。这一点在明细表的副标题里明写。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Button,
  Card,
  EmptyState,
  SearchInput,
  SegmentedControl,
  Spinner,
  TimeSeries,
  Toolbar,
} from '../../components';
import type { SegmentedOption } from '../../components';
import {
  formatCount,
  formatCostUsd,
  formatPercent,
  formatTime,
  formatTokens,
  formatTokensCn,
} from '../../lib';
import { useApp } from '../../store';
import { useNav } from '../../store/nav';
import type { UsageRow } from '../../types/contract';
import { useDiagnosticsHandoff } from '../diagnostics/handoff';
import { KpiRow } from './parts/KpiRow';
import type { KpiItem } from './parts/KpiRow';
import { UsageTable } from './parts/UsageTable';
import { PRESET_GRANULARITY, PRESET_LABEL, matchPreset, rangeFor } from './parts/range';
import type { RangeChoice } from './parts/range';
import styles from './index.module.css';

/** 条形图各取前几名；剩下的仍然计入总量，只是不画 */
const TOP_N = 8;

/** 明细表默认显示条数，避免一屏拉出两百行 */
const TABLE_PREVIEW = 60;

const GRANULARITY_OPTIONS: ReadonlyArray<SegmentedOption<'hour' | 'day'>> = [
  { value: 'hour', label: '按小时', title: '每小时一个桶，适合看今天的分布' },
  { value: 'day', label: '按天', title: '每天一个桶，适合看多天趋势' },
];

const GRANULARITY_TEXT: Record<'hour' | 'day', string> = { hour: '小时', day: '天' };

type AutorefreshChoice = 'off' | '10' | '30' | '60';

const AUTOREFRESH_OPTIONS: ReadonlyArray<SegmentedOption<AutorefreshChoice>> = [
  { value: 'off', label: '关', title: '关闭自动刷新' },
  { value: '10', label: '10s', title: '每 10 秒刷新一次' },
  { value: '30', label: '30s', title: '每 30 秒刷新一次' },
  { value: '60', label: '60s', title: '每 60 秒刷新一次' },
];

const AUTOREFRESH_KEY = 'claude1.desktop.usageAutorefresh';
const AUTOREFRESH_DEFAULT: AutorefreshChoice = '30';

/** 明细表的搜索只搜表上看得见的列，搜不到的东西不进干草堆，免得「搜到了却看不见」 */
function usageHaystack(row: UsageRow): string {
  return [formatTime(row.ts), row.channel, row.model, row.format, row.source, ...row.deg].join(' ').toLowerCase();
}

function readAutorefresh(): AutorefreshChoice {
  const saved = localStorage.getItem(AUTOREFRESH_KEY);
  if (saved === 'off' || saved === '10' || saved === '30' || saved === '60') return saved;
  return AUTOREFRESH_DEFAULT;
}

export default function UsageView() {
  const usage = useApp((state) => state.usage);
  const rows = useApp((state) => state.recentUsage);
  const range = useApp((state) => state.usageRange);
  const setUsageRange = useApp((state) => state.setUsageRange);
  const refresh = useApp((state) => state.refresh);
  const busy = useApp((state) => state.loading.usage === true);
  const usageLoaded = useApp((state) => state.loadedKeys.usage === true);
  const failure = useApp((state) => state.error.usage ?? null);
  const logsDir = useApp((state) => state.env?.logsDir ?? null);

  const setView = useNav((state) => state.setView);
  const requestDiagnostics = useDiagnosticsHandoff((state) => state.request);

  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [autorefresh, setAutorefresh] = useState<AutorefreshChoice>(readAutorefresh);

  const reload = useCallback(() => {
    void refresh('usage');
  }, [refresh]);

  /** 自动刷新：页签隐藏时真正停掉定时器（不是空唤醒），切档/卸载时清理，默认 30s */
  useEffect(() => {
    if (autorefresh === 'off') return;
    const seconds = parseInt(autorefresh, 10);
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) {
        id = setInterval(() => void refresh('usage'), seconds * 1000);
      }
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [autorefresh, refresh]);

  /** 点明细里的降级数量：把这一回合的码带到诊断视图，落地就只看这几个 */
  const inspectDegrade = useCallback(
    (row: UsageRow) => {
      requestDiagnostics('degrade', row.deg);
      setView('diagnostics');
    },
    [requestDiagnostics, setView],
  );

  const preset = matchPreset(range.fromTs);
  const rangeOptions: ReadonlyArray<SegmentedOption<RangeChoice>> = [
    { value: 'today', label: PRESET_LABEL.today, title: '今天零点到现在' },
    { value: 'week', label: PRESET_LABEL.week, title: '含今天的 7 个自然日' },
    { value: 'month', label: PRESET_LABEL.month, title: '含今天的 30 个自然日' },
    ...(preset === null
      ? ([
          {
            value: 'custom',
            label: '自定义',
            disabled: true,
            title: '当前时间窗与三个预设都不相等（多半是开着窗口跨过了零点），下面那行写的是真实窗口',
          },
        ] as ReadonlyArray<SegmentedOption<RangeChoice>>)
      : []),
  ];

  const chooseRange = useCallback(
    (next: RangeChoice) => {
      // 'custom' 只是个如实的展示态，不可选中
      if (next === 'custom') return;
      setUsageRange({ ...rangeFor(next), granularity: PRESET_GRANULARITY[next] });
    },
    [setUsageRange],
  );

  const { hero, side, bars } = useMemo(() => {
    if (usage === null) {
      return { hero: null, side: null, bars: [] as KpiItem[] };
    }
    const totals = usage.totals;
    const totalTokens = totals.in + totals.out + totals.cr + totals.cw;
    const heroItem: KpiItem = {
      label: '真实消耗 Tokens',
      value: formatCount(totalTokens),
      caption: '输入 + 输出 + 缓存读 + 缓存写，窗口内真实 token 总量',
      subValue: totalTokens >= 10_000 ? `≈ ${formatTokensCn(totalTokens)}` : undefined,
    };
    const sideItems: [KpiItem, KpiItem] = [
      {
        label: '总请求数',
        value: formatCount(totals.turns),
        caption: '窗口内记了账的回合数',
      },
      {
        label: '总成本',
        value: usage.estimatedCostUsd === null ? '—' : formatCostUsd(usage.estimatedCostUsd),
        caption:
          usage.costSource === null
            ? '未配置价格表，不估算成本；可来自 CC Switch 定价表'
            : usage.costSource === 'cc-switch-db'
              ? '按 CC Switch DB 的 model_pricing 估算'
              : '按 model-pricing.json 的单价估算',
        accent: usage.estimatedCostUsd !== null,
      },
    ];
    const barItems: KpiItem[] = [
      { label: '输入', value: formatTokens(totals.in), caption: '不含缓存读写的新输入 token' },
      { label: '输出', value: formatTokens(totals.out), caption: '模型生成的 token' },
      { label: '创建', value: formatTokens(totals.cw), caption: '写入提示缓存的输入 token' },
      { label: '命中', value: formatTokens(totals.cr), caption: '命中提示缓存的输入 token' },
      {
        label: '缓存命中率',
        value: formatPercent(usage.cacheHitRate),
        caption: '缓存读 ÷（总输入 + 缓存读）',
        progress: usage.cacheHitRate ?? 0,
      },
    ];
    return { hero: heroItem, side: sideItems, bars: barItems };
  }, [usage]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter((row) => usageHaystack(row).includes(needle));
  }, [rows, query]);

  const visible = showAll ? filtered : filtered.slice(0, TABLE_PREVIEW);

  const channelBars = useMemo(() => {
    if (usage === null) return [];
    return usage.byChannel.map((bucket) => ({
      label: bucket.key,
      values: [bucket.in, bucket.out, bucket.cr + bucket.cw],
      title: `${bucket.key}：输入 ${formatTokens(bucket.in)} ／ 输出 ${formatTokens(bucket.out)} ／ 缓存读写 ${formatTokens(bucket.cr + bucket.cw)}，共 ${formatCount(bucket.turns)} 个回合`,
    }));
  }, [usage]);

  const modelBars = useMemo(() => {
    if (usage === null) return [];
    return usage.byModel.map((bucket) => ({
      label: bucket.key,
      values: [bucket.in, bucket.out, bucket.cr + bucket.cw],
      title: `${bucket.key}：输入 ${formatTokens(bucket.in)} ／ 输出 ${formatTokens(bucket.out)} ／ 缓存读写 ${formatTokens(bucket.cr + bucket.cw)}，共 ${formatCount(bucket.turns)} 个回合`,
    }));
  }, [usage]);

  const alert =
    failure === null ? null : (
      <p className={styles.alert} role="alert">
        {`读取用量流水失败：${failure}`}
      </p>
    );

  if (usage === null) {
    return (
      <div className={styles.view}>
        {alert}
        {busy || !usageLoaded ? (
          // usage 一次都没加载过时（首帧 busy 还没置真）也走加载态，不闪「还没读到」空态
          <div className={styles.loading}>
            <Spinner size="md" label="正在读取用量流水" />
          </div>
        ) : failure === null ? (
          <EmptyState
            icon="usage"
            title="还没有读到用量聚合"
            description="用量流水读取尚未完成或未开始。这一页读的是 ~/.cc-switch/logs/ 下的 usage journal，文件不存在也会当作空。"
            action={{ label: '刷新', icon: 'refresh', onClick: reload }}
            hint={logsDir === null ? undefined : <code>{logsDir}</code>}
          />
        ) : null}
        {/* 加载已完成但失败时只留上方 alert，不再下「读取尚未完成」的结论 */}
      </div>
    );
  }

  const windowNote = `统计窗口 ${formatTime(usage.windowFrom, { seconds: false })} → ${formatTime(usage.windowTo, { seconds: false })}，按${GRANULARITY_TEXT[usage.granularity]}分桶`;

  return (
    <div className={styles.view}>
      {alert}

      {hero && side ? (
        <KpiRow hero={hero} side={side} bars={bars} aria-label="用量总览" />
      ) : null}
      <p className={styles.windowNote}>{windowNote}</p>

      <Toolbar
        divider
        aria-label="时间范围"
        right={
          <>
            {busy ? <Spinner size="sm" label="正在聚合" /> : null}
            <SegmentedControl
              options={AUTOREFRESH_OPTIONS}
              value={autorefresh}
              onChange={(next) => {
                setAutorefresh(next);
                localStorage.setItem(AUTOREFRESH_KEY, next);
              }}
              aria-label="自动刷新"
            />
            <Button
              variant="ghost"
              size="sm"
              icon="diagnostics"
              onClick={() => {
                requestDiagnostics('degrade');
                setView('diagnostics');
              }}
            >
              看降级明细
            </Button>
            <Button variant="secondary" size="sm" icon="refresh" loading={busy} onClick={reload}>
              刷新
            </Button>
          </>
        }
      >
        <SegmentedControl
          options={rangeOptions}
          value={preset ?? 'custom'}
          onChange={chooseRange}
          aria-label="时间范围"
        />
        <SegmentedControl
          options={GRANULARITY_OPTIONS}
          value={range.granularity}
          onChange={(next) => setUsageRange({ granularity: next })}
          aria-label="分桶粒度"
        />
      </Toolbar>

      {usage.totals.turns === 0 ? (
        rows.length === 0 ? (
          <EmptyState
            icon="database"
            title="本机还没有产生流水"
            description="usage journal 是空的（文件不存在也算空）。跑一次会话后回来看，这一页读的就是那个文件。"
            action={{ label: '刷新', icon: 'refresh', onClick: reload }}
            hint={logsDir === null ? undefined : <code>{logsDir}</code>}
          />
        ) : (
          <EmptyState
            icon="clock"
            title="这个时间窗里没有记账"
            description={`${windowNote}——窗口内一个回合都没有，但流水里还有更早的 ${formatCount(rows.length)} 条。把范围放宽就能看到它们。`}
            action={{ label: '看最近 30 天', icon: 'clock', onClick: () => chooseRange('month') }}
            secondaryAction={{ label: '刷新', icon: 'refresh', onClick: reload }}
          />
        )
      ) : (
        <>
          <Card title="token 走势" subtitle="青线输入、紫线输出、灰线缓存读；红色虚线为成本副轴。悬浮看具体数值">
            <TimeSeries
              data={usage.series}
              series={['in', 'out', 'cr']}
              secondary={{ key: 'cost', label: '成本', formatValue: formatCostUsd }}
              granularity={usage.granularity}
              height={220}
              ariaLabel="窗口内输入、输出、缓存读 token 走势及成本"
            />
          </Card>

          <div className={styles.grid2}>
            <Card
              title="按渠道"
              subtitle={`前 ${Math.min(TOP_N, channelBars.length)} 名，共 ${formatCount(channelBars.length)} 个渠道；堆叠是输入 ／ 输出 ／ 缓存读写`}
            >
              <BarChart
                data={channelBars}
                topN={TOP_N}
                seriesLabels={['输入', '输出', '缓存读写']}
                emptyText="这个窗口里没有任何渠道产生用量"
                ariaLabel="按渠道的 token 用量"
              />
            </Card>
            <Card
              title="按模型"
              subtitle={`前 ${Math.min(TOP_N, modelBars.length)} 名，共 ${formatCount(modelBars.length)} 个模型；堆叠是输入 ／ 输出 ／ 缓存读写`}
            >
              <BarChart
                data={modelBars}
                topN={TOP_N}
                seriesLabels={['输入', '输出', '缓存读写']}
                emptyText="这个窗口里没有任何模型产生用量"
                ariaLabel="按模型的 token 用量"
              />
            </Card>
          </div>
        </>
      )}

      <Card
        flush
        title="最近用量明细"
        subtitle={`流水里最近 ${formatCount(rows.length)} 条，倒序。这张表不受上面的时间窗限制——它读的是同一份 journal 的尾部`}
        actions={
          <SearchInput
            value={query}
            onChange={setQuery}
            aria-label="过滤用量明细"
            placeholder="搜渠道、模型、协议格式、降级码"
          />
        }
        footer={
          <>
            <span className={styles.footNote}>
              {query.trim() === ''
                ? `显示 ${formatCount(visible.length)} / ${formatCount(rows.length)} 条`
                : `显示 ${formatCount(visible.length)} 条，命中 ${formatCount(filtered.length)} 条，流水共 ${formatCount(rows.length)} 条`}
            </span>
            {filtered.length > TABLE_PREVIEW ? (
              <Button
                variant="ghost"
                size="sm"
                icon={showAll ? 'chevron-up' : 'chevron-down'}
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? `只看前 ${TABLE_PREVIEW} 条` : `展开全部 ${formatCount(filtered.length)} 条`}
              </Button>
            ) : null}
          </>
        }
      >
        {rows.length === 0 ? (
          <div className={styles.tableEmpty}>
            <EmptyState
              icon="database"
              title="本机还没有产生流水"
              description="usage journal 里一条记录都没有。跑一次会话后回来看，这张表就是那个文件的尾部。"
              action={{ label: '刷新', icon: 'refresh', onClick: reload }}
              hint={logsDir === null ? undefined : <code>{logsDir}</code>}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.tableEmpty}>
            <EmptyState
              icon="filter"
              title="没有匹配的明细"
              description={`「${query.trim()}」在最近 ${formatCount(rows.length)} 条流水的渠道、模型、协议格式与降级码里都没有出现。`}
              action={{ label: '清空搜索', icon: 'close', onClick: () => setQuery('') }}
            />
          </div>
        ) : (
          <UsageTable rows={visible} onInspectDegrade={inspectDegrade} />
        )}
      </Card>
    </div>
  );
}
