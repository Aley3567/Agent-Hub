import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../lib';
import { Icon } from './Icon';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size' | 'children'> {
  /** 选项数组；也可以不传，自己在 children 里写 <option> */
  options?: readonly SelectOption[];
  /** options 的别名 */
  items?: readonly SelectOption[];
  /** 空值选项的文案，例如「未绑定」。它是可选中的，用来清空绑定 */
  placeholder?: string;
  /** 原生 size 是可见行数，所以高度档位另起一个名字 */
  selectSize?: 'sm' | 'md';
  invalid?: boolean;
  error?: string | null;
  mono?: boolean;
  wrapperClassName?: string;
  children?: ReactNode;
}

/**
 * 原生 <select> 套自定义样式，不造下拉浮层——省依赖，也免掉一堆键盘可达性 bug
 * （DESIGN.md 第 4.1 节明确要求）。
 */
export function Select({
  options,
  items,
  placeholder,
  selectSize = 'md',
  invalid = false,
  error,
  mono = false,
  wrapperClassName,
  className,
  children,
  ...rest
}: SelectProps) {
  const list = options ?? items;
  const hasError = invalid || (error !== null && error !== undefined && error !== '');
  return (
    <span className={cx(styles.wrap, wrapperClassName)}>
      {/* 外壳跟着原生 disabled 一起变；safari15 没有 :has()，状态从这里传下去 */}
      <span
        className={cx(
          styles.field,
          styles[selectSize],
          hasError && styles.invalid,
          rest.disabled === true && styles.disabled,
        )}
      >
        <select
          className={cx(styles.select, mono && styles.mono, className)}
          aria-invalid={hasError || undefined}
          {...rest}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {list
            ? list.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))
            : children}
        </select>
        {/* 不传 size：统一走 tokens.css 的 --icon-size 栅格 */}
        <Icon name="chevron-down" className={styles.chevron} />
      </span>
      {error !== null && error !== undefined && error !== '' ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
