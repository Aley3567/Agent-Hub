/**
 * 新建 / 编辑计划任务的对话框（Dialog 最大宽 520，DESIGN.md 4.1）。
 *
 * 表单控件全部用通用原语：名称 Input、kind 三选 SegmentedControl、
 * 渠道 / hub / 槽位 Select（选项取自 useApp 的 channels / hubs）、cron 五字段 Input。
 *
 * 编辑受 update_task 的 patch 口径限制：只能改名称 / cron / 启用，kind 与目标在编辑态
 * 整体禁用并说明原因——不暗示界面能改它改不了的东西。
 *
 * 校验分工：前端只拦「空名称 / 字段数不对 / 没选渠道」这类一眼可判的输入，cron 是否合法、
 * nextRunAt 是多少一律由后端裁定；后端的中文错误原文走 toast.error，不改写。
 */
import { useEffect, useId, useState } from 'react';
import { Button, Dialog, Field, Input, SegmentedControl, Select, Switch } from '../../../components';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import type { LaunchTarget, ScheduledTask, SlotName } from '../../../types/contract';
import { KIND_LABEL, type TaskKind } from '../taskLabels';
import styles from './TaskDialog.module.css';

interface TaskDialogProps {
  open: boolean;
  /** null 表示新建；否则编辑该任务 */
  task: ScheduledTask | null;
  onClose: () => void;
}

const KIND_OPTIONS: ReadonlyArray<{ value: TaskKind; label: string }> = (
  ['launch-channel', 'launch-slot', 'doctor-reminder'] as const
).map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));

const SLOT_OPTIONS: ReadonlyArray<{ value: SlotName; label: string }> = [
  { value: 'fable', label: 'fable' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
];

/** cron 五字段占位例子，契约与 mock 都认这条 */
const CRON_PLACEHOLDER = '0 9 * * 1-5';

interface FormErrors {
  name?: string;
  channel?: string;
  schedule?: string;
}

export default function TaskDialog({ open, task, onClose }: TaskDialogProps) {
  const channels = useApp((state) => state.channels);
  const hubs = useApp((state) => state.hubs);
  const createTask = useApp((state) => state.createTask);
  const updateTask = useApp((state) => state.updateTask);
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<TaskKind>('doctor-reminder');
  const [channelId, setChannelId] = useState('');
  const [hubName, setHubName] = useState('');
  const [slot, setSlot] = useState<SlotName>('sonnet');
  const [schedule, setSchedule] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const nameId = useId();
  const channelSelectId = useId();
  const hubSelectId = useId();
  const slotSelectId = useId();
  const scheduleId = useId();

  // 每次打开都按「新建空白 / 编辑初值」重置表单，关掉再开不残留上一次输入
  useEffect(() => {
    if (!open) return;
    const target = task?.target ?? null;
    setName(task?.name ?? '');
    setKind(task?.kind ?? 'doctor-reminder');
    setChannelId(target?.kind === 'channel' ? target.channelId ?? '' : '');
    setHubName(target?.kind === 'slot' ? target.hubName ?? '' : '');
    setSlot(target?.kind === 'slot' ? target.slot ?? 'sonnet' : 'sonnet');
    setSchedule(task?.schedule ?? '');
    setEnabled(task?.enabled ?? true);
    setErrors({});
    setSubmitting(false);
  }, [open, task]);

  const editing = task !== null;

  const channelOptions = channels.map((channel) => ({ value: channel.id, label: channel.name }));
  const hubOptions = hubs.map((hub) => ({
    value: hub.name,
    label: hub.isDefault ? `${hub.name}（默认）` : hub.name,
  }));

  /** 前端只拦一眼可判的输入；cron 语义与下次运行时间仍由后端算（DESIGN.md 4.7 分工） */
  function validate(): FormErrors {
    const next: FormErrors = {};
    if (name.trim() === '') next.name = '任务名称不能为空。';
    if (schedule.trim().split(/\s+/).length !== 5) {
      next.schedule = `cron 表达式需要五个字段（分 时 日 月 周），例如 ${CRON_PLACEHOLDER}。`;
    }
    if (kind === 'launch-channel' && channelId === '') next.channel = '选择要到点启动的渠道。';
    return next;
  }

  function buildTarget(): LaunchTarget | null {
    if (kind === 'launch-channel') return { kind: 'channel', channelId };
    if (kind === 'launch-slot') {
      return { kind: 'slot', hubName: hubName === '' ? undefined : hubName, slot };
    }
    return null;
  }

  async function handleSubmit() {
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    try {
      if (task === null) {
        await createTask({
          name: name.trim(),
          kind,
          target: buildTarget(),
          schedule: schedule.trim(),
          enabled,
        });
        toastSuccess(`已创建计划任务「${name.trim()}」。`);
      } else {
        await updateTask(task.id, { name: name.trim(), schedule: schedule.trim(), enabled });
        toastSuccess(`已保存「${name.trim()}」的修改。`);
      }
      onClose();
    } catch (cause) {
      // 后端的中文错误原文直接进 toast（AGENTS.md：错误原样暴露）
      toastError(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? '编辑计划任务' : '新建计划任务'}
      description={
        editing
          ? '修改名称、cron 表达式或启用状态；下次运行时间由后端按新 cron 重算。'
          : '到点启动一个渠道 / 槽位会话，或给自己一条体检提醒。'
      }
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            loading={submitting}
            onClick={() => void handleSubmit()}
          >
            {editing ? '保存修改' : '创建任务'}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label="名称" required error={errors.name ?? null} htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：工作日早上开官方渠道"
            disabled={submitting}
          />
        </Field>

        <Field
          label="类型"
          hint={editing ? '类型与目标创建后不可修改，需要变化请删除后新建。' : undefined}
        >
          <SegmentedControl
            options={KIND_OPTIONS}
            value={kind}
            onChange={setKind}
            disabled={editing || submitting}
            fullWidth
            aria-label="任务类型"
          />
        </Field>

        {kind === 'launch-channel' ? (
          <Field label="渠道" required error={errors.channel ?? null} htmlFor={channelSelectId}>
            <Select
              id={channelSelectId}
              options={channelOptions}
              placeholder="选择渠道"
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              disabled={editing || submitting}
            />
          </Field>
        ) : null}

        {kind === 'launch-slot' ? (
          <>
            <Field label="Hub" hint="不选则使用默认 hub。" htmlFor={hubSelectId}>
              <Select
                id={hubSelectId}
                options={hubOptions}
                placeholder="默认 hub"
                value={hubName}
                onChange={(event) => setHubName(event.target.value)}
                disabled={editing || submitting}
              />
            </Field>
            <Field label="槽位" required htmlFor={slotSelectId}>
              <Select
                id={slotSelectId}
                mono
                options={SLOT_OPTIONS}
                value={slot}
                onChange={(event) => setSlot(event.target.value as SlotName)}
                disabled={editing || submitting}
              />
            </Field>
          </>
        ) : null}

        <Field
          label="cron 表达式"
          required
          error={errors.schedule ?? null}
          hint="五个字段：分 时 日 月 周。是否合法与下次运行时间由后端计算，前端不推算。"
          htmlFor={scheduleId}
        >
          <Input
            id={scheduleId}
            mono
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            placeholder={CRON_PLACEHOLDER}
            disabled={submitting}
          />
        </Field>

        <Field label="启用">
          <Switch
            checked={enabled}
            onChange={setEnabled}
            disabled={submitting}
            label={enabled ? '到点触发' : '先保存为停用状态'}
            aria-label="启用该任务"
          />
        </Field>
      </div>
    </Dialog>
  );
}
