/**
 * 单张计划任务卡片（DESIGN.md 4.7 的固定结构）：
 *   头部：名称 + kind Badge，右上「下次运行」倒计时；
 *   正文：scheduleText 人话一行 + cron 原串（mono，不隐藏）；
 *   底部：上次运行时间 + 启用 Switch + 编辑 / 删除 IconButton。
 *
 * 到点未跑显示「已错过」配琥珀 StatusDot——任务是错过，不是失败，所以不用红。
 * 启停切换直通 store 的 updateTask，失败原因原文走 toast。
 */
import { useState } from 'react';
import { Badge, Card, IconButton, StatusDot, Switch } from '../../../components';
import { formatCountdown, formatRelative, formatTime } from '../../../lib';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import type { Channel, HubConfig, ScheduledTask } from '../../../types/contract';
import { KIND_LABEL, KIND_TONE } from '../taskLabels';
import styles from './TaskCard.module.css';

interface TaskCardProps {
  task: ScheduledTask;
  channels: Channel[];
  hubs: HubConfig[];
  /** 一屏共用的基准时刻（unix 秒），由视图层定时刷新 */
  now: number;
  onEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
}

/** 目标的一行人话；doctor-reminder 没有目标，返回 null 不渲染这一行 */
function targetText(task: ScheduledTask, channels: Channel[], hubs: HubConfig[]): string | null {
  const target = task.target;
  if (task.kind === 'doctor-reminder' || target === null) return null;
  if (target.kind === 'channel') {
    const channel = channels.find((item) => item.id === target.channelId);
    if (channel) return `渠道 · ${channel.name}`;
    return `渠道 · ${target.channelId ?? '未设置'}（不在当前渠道列表中）`;
  }
  const hubName = target.hubName ?? hubs.find((hub) => hub.isDefault)?.name ?? '默认 hub';
  return `槽位 · ${hubName} · ${target.slot ?? '未设置'}`;
}

/** 右上角倒计时区：停用 / 无法解析 / 已错过 / 正常倒计时四种呈现 */
function NextRun({ task, now }: { task: ScheduledTask; now: number }) {
  if (!task.enabled) {
    return <StatusDot status="off">已停用</StatusDot>;
  }
  if (task.nextRunAt === null) {
    // enabled 却拿不到 nextRunAt：后端没能解析这条 cron，如实说出原因
    return <StatusDot status="warn">无法解析</StatusDot>;
  }
  if (task.nextRunAt <= now) {
    return <StatusDot status="warn">已错过</StatusDot>;
  }
  return (
    <span className={styles.nextValue} title={`下次运行：${formatTime(task.nextRunAt)}`}>
      {formatCountdown(task.nextRunAt, now)}
    </span>
  );
}

export default function TaskCard({ task, channels, hubs, now, onEdit, onDelete }: TaskCardProps) {
  const updateTask = useApp((state) => state.updateTask);
  const toastError = useToast((state) => state.error);
  const [toggleBusy, setToggleBusy] = useState(false);

  async function handleToggle(enabled: boolean) {
    setToggleBusy(true);
    try {
      await updateTask(task.id, { enabled });
    } catch (cause) {
      // 开关失败要让人知道：原因原文进 toast，开关状态由 refresh 回到真实值
      toastError(errorText(cause));
    } finally {
      setToggleBusy(false);
    }
  }

  const target = targetText(task, channels, hubs);

  return (
    <Card
      aria-label={`计划任务：${task.name}`}
      header={
        <>
          <div className={styles.titleRow}>
            <span className={styles.name}>{task.name}</span>
            <Badge tone={KIND_TONE[task.kind]} mono={false}>
              {KIND_LABEL[task.kind]}
            </Badge>
          </div>
          <div className={styles.next}>
            <span className={styles.nextLabel}>下次运行</span>
            <NextRun task={task} now={now} />
          </div>
        </>
      }
      footer={
        <>
          <span className={styles.meta}>
            {task.lastRunAt === null ? '还没运行过' : `上次运行 ${formatRelative(task.lastRunAt, now)}`}
          </span>
          <span className={styles.actions}>
            <Switch
              checked={task.enabled}
              disabled={toggleBusy}
              onChange={(enabled) => void handleToggle(enabled)}
              aria-label={`${task.enabled ? '停用' : '启用'}「${task.name}」`}
            />
            <IconButton icon="edit" aria-label={`编辑「${task.name}」`} onClick={() => onEdit(task)} />
            <IconButton
              icon="trash"
              variant="danger"
              aria-label={`删除「${task.name}」`}
              onClick={() => onDelete(task)}
            />
          </span>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.schedule}>{task.scheduleText}</p>
        {/* cron 原串不隐藏：人话在前、原串在后，同降级码的呈现原则（DESIGN.md 4.4） */}
        <p className={styles.cron}>{task.schedule}</p>
        {target === null ? null : <p className={styles.target}>{target}</p>}
      </div>
    </Card>
  );
}
