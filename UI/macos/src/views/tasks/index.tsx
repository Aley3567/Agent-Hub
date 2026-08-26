/**
 * 计划任务视图，回答「哪些事被定时触发，下一次什么时候跑」（CONTRACT.md 6.5 的文案锚点）。
 *
 * 形态是卡片列表（不用表格）：任务字段异构、数量少，卡片比定宽列好扫（DESIGN.md 4.7）。
 * 前后端分工写死：nextRunAt / scheduleText 由后端（或离线 mock）计算，这里只做展示与
 * 倒计时渲染，绝不在前端解析或推算 cron。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, EmptyState, SectionHeader, Spinner } from '../../components';
import { errorText, useApp } from '../../store';
import { useNav } from '../../store/nav';
import { useToast } from '../../store/toast';
import type { ScheduledTask } from '../../types/contract';
import TaskCard from './parts/TaskCard';
import TaskDialog from './parts/TaskDialog';
import styles from './index.module.css';

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
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);

  /** 新建 / 编辑对话框：null 且 dialogOpen 表示新建，否则编辑该任务 */
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

  const sorted = useMemo(() => sortTasks(tasks), [tasks]);

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
      toastSuccess(`已删除「${deleting.name}」。`);
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
        title="任务清单"
        count={tasksLoaded ? tasks.length : null}
        actions={
          <Button variant="primary" size="sm" icon="plus" onClick={openCreate}>
            新建任务
          </Button>
        }
      />

      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {(loading || !tasksLoaded) && tasks.length === 0 ? (
        <div className={styles.loading}>
          <Spinner label="正在读取计划任务" />
        </div>
      ) : null}

      {showEmpty ? (
        <EmptyState
          icon="tasks"
          title="还没有计划任务"
          description="定时启动会话、定时体检提醒的清单是空的：本地任务文件不存在，或者里面还没有任何条目。"
          action={{ label: '新建一个任务', icon: 'plus', variant: 'primary', onClick: openCreate }}
          hint="例如新建一个「每工作日 09:00」的体检提醒，到点就不用自己记了。"
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
        title="删除计划任务"
        description={deleting === null ? undefined : `「${deleting.name}」将被删除，这个操作不可撤销。`}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleting(null)} disabled={deleteBusy}>
              取消
            </Button>
            <Button variant="danger" size="sm" icon="trash" loading={deleteBusy} onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </>
        }
      />
    </div>
  );
}
