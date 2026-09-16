import { t, bilingual as b } from '../../../i18n';
import { channelKey } from '../../../types/contract';
/**
 * 新建 / 编辑计划任务的对话框（Dialog 最大宽 520，DESIGN.md 4.1）。
 *
 * 表单控件全部用通用原语：名称 Input、kind 三选 SegmentedControl、
 * 渠道 / hub / 槽位 Select（选项取自 useApp 的 channels / hubs）、
 * 重复频率走 SchedulePicker（视图专用原语，见 parts/）。
 *
 * 编辑受 update_task 的 patch 口径限制：只能改名称 / cron / 启用，kind 与目标在编辑态
 * 整体禁用并说明原因——不暗示界面能改它改不了的东西。
 *
 * 校验分工：前端只拦「空名称 / 没选渠道 / 自定义表达式字段数不对」这类一眼可判的输入，
 * cron 是否合法、nextRunAt 是多少一律由后端裁定；后端的中文错误原文走 toast.error，不改写。
 *
 * 不静默改写：用户没碰过选择器时提交原任务里的 `schedule` 原串，只有动过才写回
 * 选择器生成的 cron（SchedulePicker 的 touched 标记）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog, Field, Input, SegmentedControl, Select, Switch } from '../../../components';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import type { LaunchTarget, ScheduledTask, SlotName } from '../../../types/contract';
import { KIND_LABEL, type TaskKind } from '../taskLabels';
import SchedulePicker from './SchedulePicker';
import { detectDraft } from './schedule';
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

/** 新建任务的初始频率：工作日早九点，跟旧的占位例子同一条 */
const DEFAULT_SCHEDULE = '0 9 * * 1-5';

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
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  /** 用户是否动过 SchedulePicker；没动过就提交原串，不用选择器重算的 cron */
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<FormErrors>({});
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const nameId = useId();
  const channelSelectId = useId();
  const hubSelectId = useId();
  const slotSelectId = useId();

  // 每次打开都按「新建空白 / 编辑初值」重置表单，关掉再开不残留上一次输入
  useEffect(() => {
    if (!open) return;
    const target = task?.target ?? null;
    setName(task?.name ?? '');
    setKind(task?.kind ?? 'doctor-reminder');
    setChannelId(target?.kind === 'channel' ? `${target.appType ?? 'claude'}:${target.channelId ?? ''}` : '');
    setHubName(target?.kind === 'slot' ? target.hubName ?? '' : '');
    setSlot(target?.kind === 'slot' ? target.slot ?? 'sonnet' : 'sonnet');
    setSchedule(task?.schedule ?? DEFAULT_SCHEDULE);
    setScheduleTouched(false);
    setEnabled(task?.enabled ?? true);
    setErrors({});
    setSubmitting(false);
  }, [open, task]);

  const editing = task !== null;

  const channelOptions = channels.map((channel) => ({ value: channelKey(channel), label: `${channel.name} · ${channel.appType}` }));
  const hubOptions = hubs.map((hub) => ({
    value: hub.name,
    label: hub.isDefault ? `${hub.name} (${b(t("默认"), "default")})` : hub.name,
  }));

  /** 前端只拦一眼可判的输入；cron 语义与下次运行时间仍由后端算（DESIGN.md 4.7 分工） */
  function validate(): FormErrors {
    const next: FormErrors = {};
    if (name.trim() === '') next.name = t("任务名称不能为空。");
    // 结构化档位由选择器保证结构，只有「自定义」才需要数一数字段数
    if (detectDraft(schedule).tier === 'custom' && schedule.trim().split(/\s+/).length !== 5) {
      next.schedule = b(t("自定义表达式需要五个字段，例如 {0}。", [DEFAULT_SCHEDULE]), `A custom expression needs five fields, for example ${DEFAULT_SCHEDULE}.`);
    }
    if (kind === 'launch-channel' && channelId === '') next.channel = t("选择要到点启动的渠道。");
    return next;
  }

  /** 用户没动过选择器就原样提交任务里的串——只读不改时绝不改写 */
  function scheduleForSubmit(): string {
    if (!scheduleTouched && task !== null) return task.schedule;
    return schedule.trim();
  }

  function buildTarget(): LaunchTarget | null {
    if (kind === 'launch-channel') { const channel = channels.find((c) => channelKey(c) === channelId); return { kind: 'channel', channelId: channel?.id, appType: channel?.appType }; }
    if (kind === 'launch-slot') {
      return { kind: 'slot', hubName: hubName === '' ? undefined : hubName, slot };
    }
    return null;
  }

  async function handleSubmit() {
    if (inFlight.current) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    inFlight.current = true;
    setSubmitting(true);
    const cron = scheduleForSubmit();
    try {
      if (task === null) {
        await createTask({
          name: name.trim(),
          kind,
          target: buildTarget(),
          schedule: cron,
          enabled,
        });
        toastSuccess(b(t("已创建「{0}」。", [name.trim()]), `Created “${name.trim()}”.`));
      } else {
        await updateTask(task.id, { name: name.trim(), schedule: cron, enabled });
        toastSuccess(b(t("已保存「{0}」。", [name.trim()]), `Saved “${name.trim()}”.`));
      }
      onClose();
    } catch (cause) {
      // 后端的中文错误原文直接进 toast（AGENTS.md：错误原样暴露）
      toastError(errorText(cause));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!inFlight.current) onClose(); }}
      title={editing ? t("编辑计划任务") : t("新建计划任务")}
      description={
        editing
          ? t("修改名称、重复频率或启用状态；下次运行时间由后端按新频率重算。")
          : t("到点启动一个渠道 / 槽位会话，或给自己一条体检提醒。")
      }
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t("取消")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            loading={submitting}
            onClick={() => void handleSubmit()}
          >
            {editing ? t("保存修改") : t("创建任务")}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label={t("名称")} required error={errors.name ?? null} htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("例如：工作日早上开官方渠道")}
            disabled={submitting}
          />
        </Field>

        <Field
          label={t("类型")}
          hint={editing ? t("类型与目标创建后不可修改，需要变化请删除后新建。") : undefined}
        >
          <SegmentedControl
            options={KIND_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
            value={kind}
            onChange={setKind}
            disabled={editing || submitting}
            fullWidth
            aria-label={t("任务类型")}
          />
        </Field>

        {kind === 'launch-channel' ? (
          <Field label={t("渠道")} required error={errors.channel ?? null} htmlFor={channelSelectId}>
            <Select
              id={channelSelectId}
              options={channelOptions}
              placeholder={t("选择渠道")}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              disabled={editing || submitting}
            />
          </Field>
        ) : null}

        {kind === 'launch-slot' ? (
          <>
            <Field label="Hub" hint={t("不选则使用默认 hub。")} htmlFor={hubSelectId}>
              <Select
                id={hubSelectId}
                options={hubOptions}
                placeholder={t("默认 hub")}
                value={hubName}
                onChange={(event) => setHubName(event.target.value)}
                disabled={editing || submitting}
              />
            </Field>
            <Field label={t("槽位")} required htmlFor={slotSelectId}>
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
          label={t("重复频率")}
          required
          error={errors.schedule ?? null}
          hint={t("按本地时区重复。是否合法与下次运行时间由后端计算，前端不推算。")}
        >
          <SchedulePicker
            value={schedule}
            onChange={(next, touched) => {
              setSchedule(next);
              setScheduleTouched(touched);
            }}
            disabled={submitting}
            error={errors.schedule ?? null}
          />
        </Field>

        <Field label={t("启用")}>
          <Switch
            checked={enabled}
            onChange={setEnabled}
            disabled={submitting}
            label={enabled ? t("到点触发") : t("先保存为停用状态")}
            aria-label={t("启用该任务")}
          />
        </Field>
      </div>
    </Dialog>
  );
}
