import { useRef, useState } from 'react';
import { Icon, IconButton, Switch } from '../../../components';
import { t, bilingual as b, useLocale  } from '../../../i18n';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import type { Channel, HubConfig, ScheduledTask } from '../../../types/contract';
import { formatSchedule } from './scheduleText';
import styles from './TaskCard.module.css';
interface TaskCardProps {
  task: ScheduledTask; channels: Channel[]; hubs: HubConfig[]; now: number;
  onEdit(task: ScheduledTask): void; onDelete(task: ScheduledTask): void;
}
export default function TaskCard({ task, channels, hubs, now, onEdit, onDelete }: TaskCardProps) {
  const language = useLocale(state => state.language);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function toggle(enabled: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await useApp.getState().updateTask(task.id, { enabled }); }
    catch (cause) { useToast.getState().error(errorText(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const target = task.target;
  const channel = channels.find(item => item.id === target?.channelId && item.appType === (target?.appType ?? 'claude'));
  const targetText = target?.kind === 'channel' ? `${target.appType ?? 'claude'} · ${channel?.name ?? target.channelId}`
    : target?.kind === 'slot' ? `${target.hubName ?? hubs.find(h => h.isDefault)?.name ?? 'default'} · ${target.slot}`
    : b(t("本机体检提醒"), 'Local diagnostic reminder');
  const next = !task.enabled ? b(t("已暂停"), 'Paused') : task.nextRunAt === null ? b(t("时间表达式无效"), 'Invalid schedule')
    : task.nextRunAt <= now ? b(t("等待调度"), 'Awaiting scheduler') : `${b(t("下次"), 'Next')} ${new Date(task.nextRunAt * 1000).toLocaleString(language)}`;
  const status = { unconfirmed: b(t("结果未确认，不自动重试"), 'Unconfirmed; no automatic retry'), dispatched: b(t("会话已派发"), 'Session dispatched'), reminded: b(t("提醒已触发"), 'Reminder triggered'), failed: b(t("执行失败"), 'Dispatch failed') };
  // 人话由前端按当前语言渲染；后端附的 notes 一并放进悬浮说明，不翻译
  const human = formatSchedule(task.scheduleSpec, task.notes, language === 'en' ? 'en' : 'zh');
  const scheduleHint = [human.text, ...human.notes.map(note => t(note))].join(' · ');
  return <article className={styles.row} aria-label={task.name}>
    <span className={task.lastRunStatus === 'failed' ? styles.failed : styles.symbol}><Icon name={task.lastRunStatus === 'failed' ? 'warning' : task.lastRunStatus === 'dispatched' || task.lastRunStatus === 'reminded' ? 'check' : 'clock'} size={20} /></span>
    <div className={styles.main}>
      <button className={styles.title} type="button" onClick={() => onEdit(task)}>{task.name}</button>
      <p>{targetText} · {next}</p>
      <p title={scheduleHint}><code>{task.schedule}</code>{task.lastRunStatus ? ` · ${status[task.lastRunStatus]}` : ''}{task.lastRunAt ? ` · ${new Date(task.lastRunAt * 1000).toLocaleString(language)}` : ''}</p>
      {task.lastRunMessage ? <p className={task.lastRunStatus === 'failed' ? styles.failed : undefined}>{task.lastRunMessage}</p> : null}
    </div>
    <div className={styles.actions}>
      <Switch checked={task.enabled} disabled={busy} onChange={value => void toggle(value)} aria-label={`${b(t("启用任务"), 'Enable task')} ${task.name}`} />
      <IconButton icon="edit" aria-label={`${b(t("编辑"), 'Edit')} ${task.name}`} onClick={() => onEdit(task)} />
      <IconButton icon="trash" variant="danger" aria-label={`${b(t("删除"), 'Delete')} ${task.name}`} onClick={() => onDelete(task)} />
    </div>
  </article>;
}
