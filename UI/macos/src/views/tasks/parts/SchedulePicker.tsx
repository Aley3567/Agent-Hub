/**
 * 计划任务的可视化重复频率选择器。替掉原来让用户手写 cron 的 mono 输入框。
 *
 * 分工：本控件只负责「草稿 ↔ cron 串」的形状转换（schedule.ts），
 * cron 是否合法、下一次什么时候跑仍由后端裁定（DESIGN.md 4.7）。
 *
 * 脏标记在控件内部维护：`value` 只在用户没动过时回灌成草稿。用户一旦操作过，
 * 值就是自己写出去的，再回灌会把「自定义」档里手写出的、恰好能被识别的 cron
 * 就地跳档（比如在自定义里敲 `0 9 * * 1-5` 会被弹到「每周」），也会打断正在输入的光标。
 * 同一个标记从 onChange 的第二个参数报给调用方，提交时据此决定用不用原串。
 */
import { useEffect, useState } from 'react';
import { Input, SegmentedControl } from '../../../components';
import { t } from '../../../i18n';
import { detectDraft, toCron, type Draft, type Tier } from './schedule';
import TimeField from './TimeField';
import WeekdayPicker from './WeekdayPicker';
import styles from './SchedulePicker.module.css';

/** 切档时新档位的起始值：没有历史可继承时用早九点这个最不意外的默认 */
const DEFAULT_MINUTE = 0;
const DEFAULT_HOUR = 9;
const DEFAULT_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];

const TIER_OPTIONS: ReadonlyArray<{ value: Tier; label: string }> = [
  { value: 'hourly', get label() { return t("每小时"); } },
  { value: 'daily', get label() { return t("每天"); } },
  { value: 'weekly', get label() { return t("每周"); } },
  { value: 'custom', get label() { return t("自定义"); } },
];

interface SchedulePickerProps {
  /** 原始 cron 串 */
  value: string;
  /** 用户操作后回调；`touched` 表示草稿是否由用户改过 */
  onChange: (next: string, touched: boolean) => void;
  disabled?: boolean;
  error?: string | null;
}

/** 换档时尽量把已有的分 / 时带过去，只补没有的维度 */
function retier(current: Draft, tier: Tier): Draft {
  const minute = current.tier === 'custom' ? DEFAULT_MINUTE : current.minute;
  const hour = current.tier === 'hourly' ? DEFAULT_HOUR : current.tier === 'custom' ? DEFAULT_HOUR : current.hour;
  const carried = current.tier === 'weekly' ? current.days : DEFAULT_WORKDAYS;
  const days = carried.length > 0 ? [...carried] : [...DEFAULT_WORKDAYS];
  switch (tier) {
    case 'hourly':
      return { tier: 'hourly', minute };
    case 'daily':
      return { tier: 'daily', minute, hour };
    case 'weekly':
      return { tier: 'weekly', minute, hour, days };
    case 'custom':
      // 切到自定义时把当前草稿原样转成 cron 带过去，不丢用户已经选好的时间
      return { tier: 'custom', raw: toCron(current).trim() };
  }
}

export default function SchedulePicker({
  value,
  onChange,
  disabled = false,
  error = null,
}: SchedulePickerProps) {
  const [draft, setDraft] = useState<Draft>(() => detectDraft(value));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    setDraft(detectDraft(value));
  }, [value, touched]);

  function commit(next: Draft) {
    setDraft(next);
    setTouched(true);
    onChange(toCron(next), true);
  }

  function changeTier(tier: Tier) {
    if (tier === draft.tier) return;
    commit(retier(draft, tier));
  }

  return (
    <div className={styles.picker} aria-invalid={error === null || error === '' ? undefined : true}>
      <SegmentedControl
        options={TIER_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
        value={draft.tier}
        onChange={changeTier}
        disabled={disabled}
        fullWidth
        aria-label={t('重复频率')}
      />

      <div className={styles.controls}>
        {draft.tier === 'hourly' ? (
          <span className={styles.minuteOnly}>
            <TimeField
              showHour={false}
              hour={DEFAULT_HOUR}
              minute={draft.minute}
              disabled={disabled}
              onChange={(_hour, minute) => commit({ tier: 'hourly', minute })}
            />
          </span>
        ) : null}

        {draft.tier === 'daily' ? (
          <TimeField
            hour={draft.hour}
            minute={draft.minute}
            disabled={disabled}
            onChange={(hour, minute) => commit({ tier: 'daily', minute, hour })}
          />
        ) : null}

        {draft.tier === 'weekly' ? (
          <>
            <TimeField
              hour={draft.hour}
              minute={draft.minute}
              disabled={disabled}
              onChange={(hour, minute) => commit({ tier: 'weekly', minute, hour, days: draft.days })}
            />
            <WeekdayPicker
              value={draft.days}
              disabled={disabled}
              onChange={(days) => commit({ tier: 'weekly', minute: draft.minute, hour: draft.hour, days })}
            />
          </>
        ) : null}

        {draft.tier === 'custom' ? (
          <span className={styles.customRow}>
            <Input
              mono
              value={draft.raw}
              placeholder="0 9 * * 1-5"
              disabled={disabled}
              aria-label={t('cron 表达式')}
              onChange={(event) => commit({ tier: 'custom', raw: event.target.value })}
            />
            <span className={styles.customHint}>{t('完整五字段 cron：分 时 日 月 周')}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
