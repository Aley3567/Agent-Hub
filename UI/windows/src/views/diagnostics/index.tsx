/**
 * 诊断视图 —— 回答「失败了什么、悄悄降级了什么」。
 *
 * 这一页的全部价值在于把机器码翻成人话，同时**一个机器码都不藏**：
 *   · 降级区的每一句解释都来自 src/data/degradeCatalog，本文件不写任何解释性文案；
 *   · 未收录的码走 lookupDegrade 的兜底，照样出现在列表里；
 *   · 失败区的 message 原样脱敏后进 CodeBlock，不改写、不裁剪语义（AGENTS.md：错误原样暴露）。
 *
 * 页面结构（REDESIGN-PROMPT 1.5 / 2.3-1，验收阈值「单段 ≤2 屏且有锚点导航」）：
 * 一整页连续滚动，「降级记录」「失败列表」两个小节各有 sticky 小节头（不透明 --bg-base 底），
 * 右侧锚点导航可跳转、并随滚动高亮当前小节；每个分段超过预览上限就收起，
 * 由「展开全部」按钮放开，不再出现五屏半的连续长页。
 *
 * 数据范围要说出来：store 给的是「最近 N 条」用量与错误流水，不是全量 journal。
 * 界面上任何一处数字都标明它统计的是哪一批，否则用户会以为这就是全部历史。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  SearchInput,
  SectionHeader,
  SegmentedControl,
  Spinner,
  Table,
  Td,
  Th,
  Toolbar,
} from '../../components';
import type { SegmentedOption } from '../../components';
import { SEVERITY_LABEL, compareDegrade } from '../../data/degradeCatalog';
import type { DegradeSeverity } from '../../data/degradeCatalog';
import { MISSING, formatCount, formatRelative, formatTime } from '../../lib';
import { useApp } from '../../store';
import { useDiagnosticsHandoff } from './handoff';
import type { DiagnosticsSection } from './handoff';
import { DegradeItem } from './parts/DegradeItem';
import { FailureTable } from './parts/FailureTable';
import { FilterChips } from './parts/FilterChips';
import type { FilterChip } from './parts/FilterChips';
import { SectionNav } from './parts/SectionNav';
import {
  ORIGIN_LABEL,
  SEVERITY_KEYS,
  SEVERITY_TONE,
  collectDegradeOccurrences,
  degradeHaystack,
  groupDegradeByCode,
  occurrenceHasSeverity,
  tallySeverity,
} from './parts/aggregate';
import {
  FAILURE_KINDS,
  FAILURE_KIND_LABEL,
  FAILURE_KIND_TONE,
  buildFailureItems,
  tallyFailureKinds,
} from './parts/failure';
import type { FailureKind } from './parts/failure';
import styles from './index.module.css';

/** 降级区列出的分组：按码看「哪类妥协最多」，按回合看「那一轮到底发生了什么」 */
type Grouping = 'code' | 'turn';

const GROUPING_OPTIONS: ReadonlyArray<SegmentedOption<Grouping>> = [
  { value: 'code', label: '按降级码', title: '同一个码的多次出现合成一行，先看哪类妥协最多' },
  { value: 'turn', label: '按回合', title: '一行一个回合，同一回合的多个码折叠成「+N」' },
];

/** 每个降级码展开后最多列出多少条出现记录，避免一次撑开几百行 */
const OCCURRENCE_PREVIEW = 20;

/**
 * 单段直接列出的行数上限，超出收起成「展开全部」（REDESIGN-PROMPT 2.3-1：单段 ≤2 屏）。
 * 12 个分组约一屏、20 行表格约一屏半，都留在一屏到两屏之间。
 */
const GROUP_PREVIEW = 12;
const TURN_PREVIEW = 20;
const FAILURE_PREVIEW = 20;

/** 小节锚点的 DOM id，锚点导航与 scrollIntoView 共用 */
const SECTION_DOM_ID: Record<DiagnosticsSection, string> = {
  degrade: 'diag-degrade',
  failure: 'diag-failure',
};

function toggleKey(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function DiagnosticsView() {
  const recentUsage = useApp((state) => state.recentUsage);
  const errors = useApp((state) => state.errors);
  const refresh = useApp((state) => state.refresh);
  const usageBusy = useApp((state) => state.loading.usage === true);
  const errorsBusy = useApp((state) => state.loading.errors === true);
  const usageLoaded = useApp((state) => state.loadedKeys.usage === true);
  const errorsLoaded = useApp((state) => state.loadedKeys.errors === true);
  const usageFailure = useApp((state) => state.error.usage ?? null);
  const errorsFailure = useApp((state) => state.error.errors ?? null);
  const logsDir = useApp((state) => state.env?.logsDir ?? null);

  const focus = useDiagnosticsHandoff((state) => state.focus);
  const clearFocus = useDiagnosticsHandoff((state) => state.clear);

  const [grouping, setGrouping] = useState<Grouping>('code');
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState<DegradeSeverity | null>(null);
  const [kind, setKind] = useState<FailureKind | null>(null);
  const [codeFilter, setCodeFilter] = useState<readonly string[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [showAllFailures, setShowAllFailures] = useState(false);
  const [activeSection, setActiveSection] = useState<DiagnosticsSection>('degrade');

  const degradeRef = useRef<HTMLElement | null>(null);
  const failureRef = useRef<HTMLElement | null>(null);

  const busy = usageBusy || errorsBusy;

  /** 降级区同时吃两份流水，所以本视图的刷新要两个都拉，不能只拉 errors */
  const reload = useCallback(() => {
    void refresh('errors');
    void refresh('usage');
  }, [refresh]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setSeverity(null);
    setKind(null);
    setCodeFilter(null);
  }, []);

  /** 锚点跳转：reduced-motion 下不做平滑滚动，直接落位（DESIGN.md 2.5 reduced-motion 第 5 条） */
  const jumpTo = useCallback((section: DiagnosticsSection) => {
    const el = section === 'degrade' ? degradeRef.current : failureRef.current;
    if (el === null) return;
    setActiveSection(section);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, []);

  /** 滚动高亮：视口中线附近的一条窄带，哪个小节穿过它哪个就是「当前小节」 */
  useEffect(() => {
    const targets = [degradeRef.current, failureRef.current].filter(
      (el): el is HTMLElement => el !== null,
    );
    if (targets.length === 0) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setActiveSection(entry.target.id === SECTION_DOM_ID.failure ? 'failure' : 'degrade');
        }
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [recentUsage.length, errors.length]);

  // 用量明细点过来的跳转：滚到对应小节，只看带过来的那几个码
  useEffect(() => {
    if (focus === null) return;
    setGrouping('code');
    setQuery('');
    setSeverity(null);
    setKind(null);
    setCodeFilter(focus.codes.length === 0 ? null : [...focus.codes]);
    setExpanded(new Set(focus.codes));
    jumpTo(focus.section);
    clearFocus();
  }, [focus, clearFocus, jumpTo]);

  const needle = query.trim().toLowerCase();

  const occurrences = useMemo(() => collectDegradeOccurrences(recentUsage, errors), [recentUsage, errors]);

  /** 先套跳转带来的码筛选：汇总条的计数也应当只统计这一批 */
  const scoped = useMemo(() => {
    if (codeFilter === null) return occurrences;
    return occurrences.filter((item) => item.codes.some((code) => codeFilter.includes(code)));
  }, [occurrences, codeFilter]);

  const tally = useMemo(() => tallySeverity(scoped), [scoped]);

  const bySeverity = useMemo(() => {
    if (severity === null) return scoped;
    return scoped.filter((item) => occurrenceHasSeverity(item, severity));
  }, [scoped, severity]);

  const turns = useMemo(() => {
    const list = needle === '' ? bySeverity : bySeverity.filter((item) => degradeHaystack(item).includes(needle));
    // 默认把 lossy 排最前：那些会让人损失钱、可复现性或原始证据，必须先被看到。
    // 每个回合的 codes 已按严重度排过，codes[0] 就是这一回合最严重的那个码；同档再按时间倒序。
    return [...list].sort((left, right) => compareDegrade(left.codes[0], right.codes[0]) || right.ts - left.ts);
  }, [bySeverity, needle]);

  const groups = useMemo(() => {
    let list = groupDegradeByCode(bySeverity);
    // bySeverity 是「含该档码的回合」，聚合出来会带上同回合的其他档，这里再收一次
    if (severity !== null) list = list.filter((group) => group.severity === severity);
    if (codeFilter !== null) list = list.filter((group) => codeFilter.includes(group.code));
    if (needle === '') return list;
    return list.filter(
      (group) =>
        `${group.code} ${group.entry.title}`.toLowerCase().includes(needle) ||
        group.occurrences.some((item) => degradeHaystack(item).includes(needle)),
    );
  }, [bySeverity, severity, codeFilter, needle]);

  const failureItems = useMemo(() => buildFailureItems(errors), [errors]);
  const kindTally = useMemo(() => tallyFailureKinds(failureItems), [failureItems]);
  const failures = useMemo(() => {
    const byKind = kind === null ? failureItems : failureItems.filter((item) => item.narrative.kind === kind);
    if (needle === '') return byKind;
    return byKind.filter((item) => item.haystack.includes(needle));
  }, [failureItems, kind, needle]);

  const severityChips: Array<FilterChip<DegradeSeverity>> = SEVERITY_KEYS.map((key) => ({
    id: key,
    label: SEVERITY_LABEL[key],
    count: tally[key],
    tone: SEVERITY_TONE[key],
  }));
  const totalCodeHits = SEVERITY_KEYS.reduce((sum, key) => sum + tally[key], 0);

  const kindChips: Array<FilterChip<FailureKind>> = FAILURE_KINDS.map((key) => ({
    id: key,
    label: FAILURE_KIND_LABEL[key],
    count: kindTally[key],
    tone: FAILURE_KIND_TONE[key],
  }));

  const journalEmpty = recentUsage.length === 0 && errors.length === 0;
  /**
   * 空态结论只在两份流水都加载过、当前没在刷、也没有读取错误时才下：
   * 加载期间 recentUsage 与 errors 本来就是空的，拿它当「本机还没有流水」的证据
   * 会让空态挂满整个加载过程。流水、降级、失败三处共用这一个口径。
   */
  const loaded = usageLoaded && errorsLoaded;
  const hasFailure = usageFailure !== null || errorsFailure !== null;
  const settled = loaded && !busy && !hasFailure;
  const filtersActive = needle !== '' || severity !== null || kind !== null || codeFilter !== null;

  /** 空态一律说清「为什么空」：journal 不存在、这批记录里确实没有、还是筛窄了 */
  const emptyJournal = (
    <EmptyState
      hero
      title="本机还没有产生流水"
      description="用量与错误 journal 都是空的（文件不存在也算空）。跑一次会话后回来看，这一页读的就是那两个文件。"
      action={{ label: '刷新', icon: 'refresh', onClick: reload }}
      hint={logsDir === null ? undefined : <code>{logsDir}</code>}
    />
  );

  const emptyFiltered = (
    <EmptyState
      icon="filter"
      title="当前筛选没有匹配项"
      description="筛选条件把所有记录都排除掉了。清空后再逐项收窄，就能看出是哪一条把结果筛空的。"
      action={{ label: '清空筛选', icon: 'close', onClick: clearFilters }}
    />
  );

  const visibleGroups = showAllGroups ? groups : groups.slice(0, GROUP_PREVIEW);
  const visibleTurns = showAllTurns ? turns : turns.slice(0, TURN_PREVIEW);
  const visibleFailures = showAllFailures ? failures : failures.slice(0, FAILURE_PREVIEW);

  return (
    <div className={styles.view}>
      {usageFailure === null ? null : (
        <p className={styles.alert} role="alert">
          {`读取用量流水失败：${usageFailure}`}
        </p>
      )}
      {errorsFailure === null ? null : (
        <p className={styles.alert} role="alert">
          {`读取错误流水失败：${errorsFailure}`}
        </p>
      )}

      <Toolbar
        sticky
        divider
        aria-label="诊断筛选"
        right={
          <>
            {busy ? <Spinner size="sm" label="正在读流水" /> : null}
            {filtersActive ? (
              <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>
                清空筛选
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" icon="refresh" loading={busy} onClick={reload}>
              刷新
            </Button>
          </>
        }
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          aria-label="过滤诊断记录"
          placeholder="搜降级码、人话标题、状态码、渠道、模型、原文"
        />
      </Toolbar>

      {journalEmpty ? (
        !loaded || busy ? (
          // 两份流水一次都没加载过时（首帧 busy 还没置真）也走加载态；已空的数据
          // 再刷新时请求在途同样不得下空态结论（上方 settled 的同一口径）
          <div className={styles.loading}>
            <Spinner size="md" label="正在读取诊断流水" />
          </div>
        ) : hasFailure ? null : (
          emptyJournal
        )
      ) : (
        <div className={styles.layout}>
          <div className={styles.main}>
            <section
              ref={degradeRef}
              id={SECTION_DOM_ID.degrade}
              className={styles.section}
              aria-label="降级记录"
            >
              <div className={styles.sectionHead}>
                <SectionHeader
                  title="降级记录"
                  count={occurrences.length}
                  subtitle={`最近 ${recentUsage.length} 条用量与 ${errors.length} 条错误流水里的 HUB_DEGRADE_* 码。`}
                  actions={
                    <SegmentedControl
                      options={GROUPING_OPTIONS}
                      value={grouping}
                      onChange={setGrouping}
                      aria-label="降级列表分组"
                    />
                  }
                />
              </div>

              <FilterChips
                aria-label="按严重度筛选降级"
                chips={severityChips}
                active={severity}
                onChange={setSeverity}
                allLabel="全部"
                allCount={totalCodeHits}
              />

              {codeFilter === null ? null : (
                <div className={styles.handoff} role="status">
                  <Icon name="filter" size={14} />
                  <span className={styles.handoffText}>{`只看从用量明细带过来的 ${codeFilter.length} 个降级码`}</span>
                  {codeFilter.map((code) => (
                    <Badge key={code} tone="warn">
                      {code}
                    </Badge>
                  ))}
                  <Button variant="ghost" size="sm" icon="close" onClick={() => setCodeFilter(null)}>
                    看全部降级
                  </Button>
                </div>
              )}

              {occurrences.length === 0 ? (
                settled ? (
                  <EmptyState
                    icon="success"
                    title="这批记录里没有降级"
                    description={`最近 ${recentUsage.length} 条用量与 ${errors.length} 条失败里，一个 HUB_DEGRADE_ 码都没有——这几轮协议桥没做过任何妥协。`}
                    action={{ label: '刷新', icon: 'refresh', onClick: reload }}
                  />
                ) : null
              ) : grouping === 'code' ? (
                groups.length === 0 ? (
                  emptyFiltered
                ) : (
                  <>
                    <Card flush>
                      <ul className={styles.list} aria-label="按降级码聚合">
                        {visibleGroups.map((group) => (
                          <DegradeItem
                            key={group.code}
                            entries={[group.entry]}
                            count={group.count}
                            expanded={expanded.has(group.code)}
                            onToggle={() => setExpanded((prev) => toggleKey(prev, group.code))}
                            meta={`最近一次 ${formatRelative(group.lastTs)}`}
                            footer={
                              <div className={styles.occurrences}>
                                <Table dense minWidth={620} framed={false} aria-label={`${group.code} 的出现记录`}>
                                  <thead>
                                    <tr>
                                      <Th>时间</Th>
                                      <Th>来源</Th>
                                      <Th>渠道</Th>
                                      <Th>模型</Th>
                                      <Th>同一回合的其他码</Th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {group.occurrences.slice(0, OCCURRENCE_PREVIEW).map((item) => {
                                      const others = item.codes.filter((code) => code !== group.code);
                                      return (
                                        <tr key={item.id}>
                                          <Td mono>{formatTime(item.ts)}</Td>
                                          <Td>{ORIGIN_LABEL[item.origin]}</Td>
                                          <Td mono truncate title={item.channel ?? '流水未记录渠道'}>
                                            {item.channel ?? MISSING}
                                          </Td>
                                          <Td mono truncate title={item.model ?? '流水未记录模型'}>
                                            {item.model ?? MISSING}
                                          </Td>
                                          <Td mono truncate title={others.join('、')}>
                                            {others.length === 0 ? MISSING : others.join('、')}
                                          </Td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </Table>
                                {group.occurrences.length > OCCURRENCE_PREVIEW ? (
                                  <p className={styles.more}>
                                    {`还有 ${group.occurrences.length - OCCURRENCE_PREVIEW} 条出现记录没列出，换到「按回合」可以逐条看。`}
                                  </p>
                                ) : null}
                              </div>
                            }
                          />
                        ))}
                      </ul>
                    </Card>
                    {groups.length > GROUP_PREVIEW ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={showAllGroups ? 'chevron-up' : 'chevron-down'}
                        onClick={() => setShowAllGroups((prev) => !prev)}
                      >
                        {showAllGroups
                          ? `只看前 ${GROUP_PREVIEW} 个`
                          : `展开全部 ${formatCount(groups.length)} 个降级码`}
                      </Button>
                    ) : null}
                  </>
                )
              ) : turns.length === 0 ? (
                emptyFiltered
              ) : (
                <>
                  <Card flush>
                    <ul className={styles.list} aria-label="按回合列出降级">
                      {visibleTurns.map((item) => (
                        <DegradeItem
                          key={item.id}
                          entries={item.entries}
                          expanded={expanded.has(item.id)}
                          onToggle={() => setExpanded((prev) => toggleKey(prev, item.id))}
                          meta={
                            <>
                              <span>{formatTime(item.ts)}</span>
                              <span>{ORIGIN_LABEL[item.origin]}</span>
                              {item.channel === null || item.channel === '' ? null : <span>{item.channel}</span>}
                              {item.model === null || item.model === '' ? null : <span>{item.model}</span>}
                            </>
                          }
                        />
                      ))}
                    </ul>
                  </Card>
                  {turns.length > TURN_PREVIEW ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={showAllTurns ? 'chevron-up' : 'chevron-down'}
                      onClick={() => setShowAllTurns((prev) => !prev)}
                    >
                      {showAllTurns
                        ? `只看前 ${TURN_PREVIEW} 个`
                        : `展开全部 ${formatCount(turns.length)} 个回合`}
                    </Button>
                  ) : null}
                </>
              )}
            </section>

            <section
              ref={failureRef}
              id={SECTION_DOM_ID.failure}
              className={styles.section}
              aria-label="失败列表"
            >
              <div className={styles.sectionHead}>
                <SectionHeader
                  title="失败列表"
                  count={failureItems.length}
                  subtitle={`错误流水里的最近 ${failureItems.length} 条，状态码与错误体原样呈现。`}
                />
              </div>

              <FilterChips
                aria-label="按失败类型筛选"
                chips={kindChips}
                active={kind}
                onChange={setKind}
                allLabel="全部"
                allCount={failureItems.length}
              />

              {failureItems.length === 0 ? (
                settled ? (
                  <EmptyState
                    icon="success"
                    title="没有失败记录"
                    description={`错误流水里一条都没有，最近 ${recentUsage.length} 条用量全都跑通了。`}
                    action={{ label: '刷新', icon: 'refresh', onClick: reload }}
                  />
                ) : null
              ) : failures.length === 0 ? (
                emptyFiltered
              ) : (
                <>
                  <Card flush>
                    <FailureTable
                      items={visibleFailures}
                      expanded={expanded}
                      onToggle={(key) => setExpanded((prev) => toggleKey(prev, key))}
                      onInspectDegrade={(codes) => {
                        setGrouping('code');
                        setQuery('');
                        setSeverity(null);
                        setCodeFilter([...codes]);
                        setExpanded(new Set(codes));
                        jumpTo('degrade');
                      }}
                    />
                  </Card>
                  {failures.length > FAILURE_PREVIEW ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={showAllFailures ? 'chevron-up' : 'chevron-down'}
                      onClick={() => setShowAllFailures((prev) => !prev)}
                    >
                      {showAllFailures
                        ? `只看前 ${FAILURE_PREVIEW} 条`
                        : `展开全部 ${formatCount(failures.length)} 条失败`}
                    </Button>
                  ) : null}
                </>
              )}
            </section>
          </div>

          <SectionNav
            className={styles.rail}
            aria-label="诊断小节导航"
            active={activeSection}
            onJump={jumpTo}
            items={[
              { id: 'degrade', label: '降级记录', count: occurrences.length },
              { id: 'failure', label: '失败列表', count: failureItems.length },
            ]}
          />
        </div>
      )}
    </div>
  );
}
