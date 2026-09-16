/**
 * 时 + 分两个选择器。视图专用原语，放 parts/ 而不是通用 components/
 * （CONTRACT.md 6.3：通用层只收纳跨视图复用的原语）。
 *
 * 复用既有 Select（原生 <select>），不新造 NumberInput——键盘、IME、屏幕阅读器
 * 的行为都跟着原生控件走，少一批自造轮子的可达性 bug。
 */
import { Select } from '../../../components';
import { t, bilingual as b  } from '../../../i18n';
import styles from './TimeField.module.css';

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: String(hour).padStart(2, '0'),
}));

const MINUTES = Array.from({ length: 60 }, (_, minute) => ({
  value: String(minute),
  label: String(minute).padStart(2, '0'),
}));

interface TimeFieldProps {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  disabled?: boolean;
  /** 「每小时」档没有小时维度可选：只留分钟，省得摆一个不生效的下拉 */
  showHour?: boolean;
}

export default function TimeField({
  hour,
  minute,
  onChange,
  disabled = false,
  showHour = true,
}: TimeFieldProps) {
  return (
    <span className={styles.row}>
      {showHour ? (
        <>
          <Select
            selectSize="sm"
            mono
            options={HOURS}
            value={String(hour)}
            aria-label={b(t("小时"), 'Hour')}
            disabled={disabled}
            onChange={(event) => onChange(Number(event.target.value), minute)}
          />
          <span className={styles.separator} aria-hidden="true">
            :
          </span>
        </>
      ) : null}
      <Select
        selectSize="sm"
        mono
        options={MINUTES}
        value={String(minute)}
        aria-label={b(t("分钟"), 'Minute')}
        disabled={disabled}
        onChange={(event) => onChange(hour, Number(event.target.value))}
      />
    </span>
  );
}
