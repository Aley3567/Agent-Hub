/**
 * 星期多选。通用层没有多选控件（Select 与 SegmentedControl 都只支持单选），
 * 所以按 CONTRACT.md 6.3 落在视图自己的 parts/ 下。
 *
 * 选中态同时给 variant 与 aria-pressed：颜色不是唯一的语义载体，
 * 屏幕阅读器和强制高对比模式下照样能读出「星期三是选中的」（DESIGN.md 第 6 节）。
 */
import { Button } from '../../../components';
import { bilingual as b } from '../../../i18n';
import styles from './WeekdayPicker.module.css';

/** 下标即 cron 的周字段值：0 = 周日 … 6 = 周六 */
const DAY_LABELS: ReadonlyArray<{ short: string; full: [string, string] }> = [
  { short: '日', full: ['周日', 'Sunday'] },
  { short: '一', full: ['周一', 'Monday'] },
  { short: '二', full: ['周二', 'Tuesday'] },
  { short: '三', full: ['周三', 'Wednesday'] },
  { short: '四', full: ['周四', 'Thursday'] },
  { short: '五', full: ['周五', 'Friday'] },
  { short: '六', full: ['周六', 'Saturday'] },
];

interface WeekdayPickerProps {
  /** 升序去重的日期下标；至少一天，取消最后一天是空操作 */
  value: readonly number[];
  onChange: (days: number[]) => void;
  disabled?: boolean;
}

export default function WeekdayPicker({ value, onChange, disabled = false }: WeekdayPickerProps) {
  function toggle(day: number, selected: boolean) {
    // 取消最后一天等于「每周但一天都不跑」，是个说不通的档位：直接忽略这次点击，
    // 让控件始终停在至少一天上，而不是先放用户进去再由提交校验弹回来
    if (selected && value.length === 1) return;
    const next = selected
      ? value.filter((item) => item !== day)
      : [...value.filter((item) => item !== day), day].sort((a, b2) => a - b2);
    onChange(next);
  }

  return (
    <div className={styles.row} role="group" aria-label={b('星期', 'Weekdays')}>
      {DAY_LABELS.map((day, index) => {
        const selected = value.includes(index);
        const [zhName, enName] = day.full;
        return (
          <Button
            key={index}
            className={styles.day}
            size="sm"
            variant={selected ? 'primary' : 'secondary'}
            aria-pressed={selected}
            aria-label={b(zhName, enName)}
            disabled={disabled}
            onClick={() => toggle(index, selected)}
          >
            {day.short}
          </Button>
        );
      })}
    </div>
  );
}
