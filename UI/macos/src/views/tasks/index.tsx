/**
 * 计划任务视图，回答「哪些事被定时触发，下一次什么时候跑」（CONTRACT.md 6.5 的文案锚点）。
 *
 * 搜索与状态筛选下的任务行；派发结果不代表模型会话完成。
 * nextRunAt 由后端（或离线 mock）计算，这里只做展示与倒计时渲染，绝不在前端推算。
 * 重复频率的人话由前端按 scheduleSpec 渲染（views/tasks/parts/scheduleText.ts）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, EmptyState, Input, SegmentedControl, SectionHeader, Spinner } from '../../components';
import { errorText, useApp } from '../../store';
import { useNav } from '../../store/nav';
import { useToast } from '../../store/toast';
import type { ScheduledTask } from '../../types/contract';
import TaskCard from './parts/TaskCard';
import TaskDialog from './parts/TaskDialog';
import { formatSchedule } from './parts/scheduleText';
import styles from './index.module.css';
import { t, bilingual as b, useLocale  } from '../../i18n';
import { isOffline } from '../../api';

/** 倒计时刷新周期（ms）。倒计时最小单位是分钟，30s 一刷足够跟手 */
const COUNTDOWN_TICK_MS = 30_000;

/** 启用的排前、按下次运行时间升序；停用与无法解析的排后——「下一次什么时候跑」要可扫读 */
function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  const rank = (task: ScheduledTask): number => {
    if (!task.enabled) return 2;
    if (task.nextRunAt === null) return 1;
    return 0;
  };
  return [...tasks].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER);
  });
}

export default function TasksView() {
  const tasks = useApp((state) => state.tasks);
  const channels = useApp((state) => state.channels);
  const hubs = useApp((state) => state.hubs);
  const loading = useApp((state) => state.loading.tasks === true);
  const tasksLoaded = useApp((state) => state.loadedKeys.tasks === true);
  const reason = useApp((state) => state.error.tasks ?? null);
  const refresh = useApp((state) => state.refresh);
  const deleteTask = useApp((state) => state.deleteTask);
  const registerViewReload = useNav((state) => state.registerViewReload);
  const language = useLocale((state) => state.language);
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);

  /** 新建 / 编辑对话框：null 且 dialogOpen 表示新建，否则编辑该任务 */
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'enabled' | 'paused' | 'completed'>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 倒计时需要一个随时间前进的基准；一屏共用同一个 now，避免相邻卡片口径不一
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // 壳层「刷新」转发到本视图（CONTRACT.md 6.2）；卸载时必须传 null 注销
  useEffect(() => {
    registerViewReload('tasks', () => refresh('tasks'));
    return () => registerViewReload('tasks', null);
  }, [registerViewReload, refresh]);

  // 搜索口径带上频率的人话，这样「工作日」「每周三」也能搜到，不必背 cron 串
  const locale = language === 'en' ? 'en' as const : 'zh' as const;
  const sorted = useMemo(() => sortTasks(tasks).filter(task => {
    const human = formatSchedule(task.scheduleSpec, task.notes, locale).text;
    if (!`${task.name} ${task.schedule} ${human}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())) return false;
    if (filter === 'enabled') return task.enabled;
    if (filter === 'paused') return !task.enabled;
    if (filter === 'completed') return task.lastRunStatus === 'dispatched' || task.lastRunStatus === 'reminded';
    return true;
  }), [tasks, query, filter, locale]);

  // tasks 一次都没加载过时（首帧 loading 还没置真）不下「没有任务」的结论
  const showEmpty = tasksLoaded && tasks.length === 0 && !loading && reason === null;

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(task: ScheduledTask) {
    setEditing(task);
    setDialogOpen(true);
  }

  async function confirmDelete() {
    if (deleting === null) return;
    setDeleteBusy(true);
    try {
      await deleteTask(deleting.id);
      toastSuccess(b(t("已删除「{0}」。", [deleting.name]), `Deleted “${deleting.name}”.`));
      setDeleting(null);
    } catch (cause) {
      // IPC 的中文错误原文直接给 toast，不改写（AGENTS.md：错误原样暴露）
      toastError(errorText(cause));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className={styles.view}>
      <SectionHeader
        title={b(t("任务清单"), "Scheduled tasks")}
        count={tasksLoaded ? tasks.length : null}
        actions={
          <Button variant="primary" size="sm" icon="plus" onClick={openCreate}>
            {b(t("新建任务"), "New task")}
          </Button>
        }
      />

      <p className={styles.note}>{isOffline ? b(t("离线示例，不会执行任务。"), 'Offline examples; tasks will not run.') : b(t("保持应用运行即可按本地时区执行。退出、重启或长时间休眠不补跑；启动类任务只确认终端派发。"), 'Runs in your local time zone while the app is open. No catch-up after exit, restart or sleep; session tasks confirm terminal handoff only.')}</p>
      <Input leadingIcon="search" aria-label={b(t("搜索定时任务"), 'Search scheduled tasks')} placeholder={b(t("搜索已安排任务"), 'Search scheduled tasks')} value={query} onChange={e => setQuery(e.target.value)} />
      <SegmentedControl aria-label={b(t("任务状态"), 'Task status')} value={filter} onChange={setFilter} options={[
        { value: 'all', label: b(t("全部"), 'All') }, { value: 'enabled', label: b(t("已开启"), 'Enabled') },
        { value: 'paused', label: b(t("已暂停"), 'Paused') }, { value: 'completed', label: b(t("最近成功"), 'Recent successes') },
      ]} />
      {tasksLoaded && tasks.length > 0 && sorted.length === 0 ? <p className={styles.note}>{b(t("没有匹配的任务"), 'No matching tasks')}</p> : null}
      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {(loading || !tasksLoaded) && tasks.length === 0 ? (
        <div className={styles.loading}>
          <Spinner label={b(t("正在读取计划任务"), "Loading scheduled tasks")} />
        </div>
      ) : null}

      {showEmpty ? (
        <EmptyState
          icon="tasks"
          title={b(t("还没有定时任务"), "No scheduled tasks yet")}
          description={b(t("创建定时启动渠道或本机体检提醒。"), "Schedule a channel session or a local diagnostic reminder.")}
          action={{ label: b(t("新建一个任务"), 'Create a task'), icon: 'plus', variant: 'primary', onClick: openCreate }}
          hint={b(t("提醒会保留在任务的最近结果中；周期任务触发后仍按计划运行。"), "Reminders remain in the task result. Recurring tasks stay scheduled after each run.")}
        />
      ) : null}

      {sorted.length === 0 ? null : (
        <div className={styles.list}>
          {sorted.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              channels={channels}
              hubs={hubs}
              now={now}
              onEdit={openEdit}
              onDelete={setDeleting}
            />
          ))}
        </div>
      )}

      <TaskDialog open={dialogOpen} task={editing} onClose={() => setDialogOpen(false)} />

      {/* 删除是不可逆操作，先确认再执行（DESIGN.md 4.7：删除前走 Dialog 确认） */}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={b(t("删除计划任务"), "Delete scheduled task")}
        description={deleting === null ? undefined : b(t("「{0}」将被删除，这个操作不可撤销。", [deleting.name]), `Delete “${deleting.name}”? This cannot be undone.`)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleting(null)} disabled={deleteBusy}>
              {b(t("取消"), "Cancel")}
            </Button>
            <Button variant="danger" size="sm" icon="trash" loading={deleteBusy} onClick={() => void confirmDelete()}>
              {b(t("确认删除"), "Delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
