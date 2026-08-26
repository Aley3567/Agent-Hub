import type { KeyboardEvent } from 'react';
import { cx } from '../lib';
import { Icon } from './Icon';
import styles from './SearchInput.module.css';

export interface SearchInputProps {
  value: string;
  /** 回调直接给新的字符串，不给事件对象 */
  onChange: (value: string) => void;
  placeholder?: string;
  /** 点清空按钮时的附加回调；清空本身已经内置 */
  onClear?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  className?: string;
  /** 无障碍名，默认「搜索」 */
  'aria-label'?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索',
  onClear,
  onKeyDown,
  disabled = false,
  autoFocus = false,
  id,
  className,
  'aria-label': ariaLabel = '搜索',
}: SearchInputProps) {
  return (
    <span className={cx(styles.field, disabled && styles.disabled, className)}>
      <Icon name="search" size={14} className={styles.icon} />
      <input
        id={id}
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value === '' ? null : (
        <button
          type="button"
          className={styles.clear}
          aria-label="清空搜索"
          onClick={() => {
            onChange('');
            onClear?.();
          }}
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </span>
  );
}
