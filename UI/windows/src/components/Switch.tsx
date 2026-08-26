import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  /** 回调直接给新的开关值，不给事件对象 */
  onChange?: (checked: boolean) => void;
  /** onChange 的别名 */
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** 右侧文字，同时充当点击区 */
  label?: ReactNode;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** 36×20，轨道 --border-strong，开启转 --accent（DESIGN.md 第 4.1 节） */
export function Switch({
  checked,
  onChange,
  onCheckedChange,
  disabled = false,
  label,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: SwitchProps) {
  function toggle() {
    if (disabled) return;
    onChange?.(!checked);
    onCheckedChange?.(!checked);
  }
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={toggle}
      className={cx(styles.root, checked && styles.on, className)}
    >
      <span className={styles.track}>
        <span className={styles.knob} />
      </span>
      {label === null || label === undefined || label === '' ? null : (
        <span className={styles.label}>{label}</span>
      )}
    </button>
  );
}
