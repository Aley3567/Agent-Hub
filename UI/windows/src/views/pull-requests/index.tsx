import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Icon, Input, SegmentedControl, Spinner } from '../../components';
import { listPullRequests, openPullRequest, isOffline } from '../../api';
import { bilingual as b, useLocale } from '../../i18n';
import { errorText } from '../../store';
import { useNav } from '../../store/nav';
import { useToast } from '../../store/toast';
import type { PullRequest } from '../../types/contract';
import styles from './index.module.css';

type Filter = 'all' | 'review' | 'authored';
export default function PullRequestsView() {
  const language = useLocale(state => state.language);
  const [filter, setFilter] = useState<Filter>('all');
  const [repository, setRepository] = useState('');
  const [repoDraft, setRepoDraft] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const register = useNav(s => s.registerViewReload);
  const reload = useCallback(async () => {
    const current = ++revision.current;
    setLoading(true); setError(null); setRows([]);
    try {
      const items = await listPullRequests(filter, repository);
      if (revision.current === current) setRows(items);
    } catch (cause) {
      if (revision.current === current) setError(errorText(cause));
    } finally { if (revision.current === current) setLoading(false); }
  }, [filter, repository]);
  useEffect(() => { void reload(); return () => { revision.current++; }; }, [reload]);
  useEffect(() => { register('pullRequests', reload); return () => register('pullRequests', null); }, [register, reload]);
  const needle = query.toLocaleLowerCase().trim();
  const visible = rows.filter(row => `${row.title} ${row.repository.nameWithOwner} ${row.author.login} #${row.number}`.toLocaleLowerCase().includes(needle));
  async function open(row: PullRequest) {
    try { await openPullRequest(row.url); } catch (cause) { useToast.getState().error(errorText(cause)); }
  }
  return <div className={styles.view}>
    <SegmentedControl<Filter> aria-label={b('PR 筛选', 'PR filter')} value={filter} onChange={setFilter} options={[
      { value: 'all', label: b('全部相关', 'All involving me') },
      { value: 'review', label: b('需要我审查', 'Review requested') },
      { value: 'authored', label: b('由我创建', 'Created by me') },
    ]} />
    <Input leadingIcon="search" aria-label={b('搜索 Pull Request', 'Search pull requests')} placeholder={b('搜索标题、仓库或作者', 'Search title, repository or author')} value={query} onChange={e => setQuery(e.target.value)} />
    <form className={styles.repo} onSubmit={e => { e.preventDefault(); setRepository(repoDraft.trim()); }}>
      <Input aria-label={b('仓库', 'Repository')} placeholder={b('所有仓库，或输入 owner/repository', 'All repositories, or owner/repository')} value={repoDraft} onChange={e => setRepoDraft(e.target.value)} />
      <Button type="submit" size="sm" variant="secondary">{b('应用', 'Apply')}</Button>
    </form>
    <p className={styles.note}>{b('显示 GitHub 上与你相关的开放 PR，按更新时间排序，最多 100 条。使用本机 gh 登录。', 'Open GitHub PRs involving you, sorted by update, up to 100. Uses your local gh sign-in.')}</p>
    {loading ? <Spinner label={b('正在读取 PR', 'Loading pull requests')} /> : null}
    {error ? <div className={styles.error} role="alert"><p>{error}</p>{!isOffline ? <Button size="sm" onClick={() => void reload()}>{b('重试', 'Retry')}</Button> : null}</div> : null}
    {!loading && !error && visible.length === 0 ? <EmptyState icon="pull-request" title={b('没有匹配的 Pull Request', 'No matching pull requests')} description={b('尝试切换筛选或清空搜索。', 'Try another filter or clear your search.')} action={{ label: b('清空搜索', 'Clear search'), onClick: () => setQuery('') }} /> : null}
    <div className={styles.list}>
      {visible.map(row => <button key={row.url} type="button" className={styles.row} onClick={() => void open(row)} aria-label={`${row.title} · ${row.repository.nameWithOwner} #${row.number}`}>
        <span className={row.isDraft ? styles.draft : styles.open}><Icon name="pull-request" size={20} /></span>
        <span className={styles.main}><strong>{row.title}</strong><span>{row.repository.nameWithOwner} · #{row.number} · {row.author.login}{row.isDraft ? b(' · 草稿', ' · Draft') : ''}</span></span>
        <time className={styles.date} dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleDateString(language)}</time>
        <Icon name="external" size={14} />
      </button>)}
    </div>
  </div>;
}
