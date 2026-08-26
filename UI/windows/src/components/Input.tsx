import type { ComponentPropsWithRef } from 'react';
import { cx } from '../lib';
import { Icon, type IconName } from './Icon';
import styles from './Input.module.css';

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  /** 错误态：描边转 --danger */
  invalid?: boolean;
  /** 错误说明，渲染在输入框下方（--fs-12）。给了就自动进入错误态 */
  error?: string | null;
  /** 常态说明，仅在没有 error 时显示 */
  hint?: string | null;
  /** 内容是模型 id、端口这类技术标识时打开，转等宽字体 */
  mono?: boolean;
  /** 原生 size 是字符数，所以高度档位另起一个名字 */
  inputSize?: 'sm' | 'md';
  leadingIcon?: IconName;
  /** 作用在外层容器上的类名，用来控制宽度 */
  wrapperClassName?: string;
}

export function Input({
  invalid = false,
  error,
  hint,
  mono = false,
  inputSize = 'md',
  leadingIcon,
  wrapperClassName,
  className,
  ...rest
}: InputProps) {
  const hasError = invalid || (error !== null && error !== undefined && error !== '');
  return (
    <span className={cx(styles.wrap, wrapperClassName)}>
      <span className={cx(styles.field, styles[inputSize], hasError && styles.invalid)}>
        {leadingIcon ? <Icon name={leadingIcon} size={14} className={styles.leading} /> : null}
        <input
          className={cx(styles.input, mono && styles.mono, className)}
          aria-invalid={hasError || undefined}
          {...rest}
        />
      </span>
      {error !== null && error !== undefined && error !== '' ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : hint !== null && hint !== undefined && hint !== '' ? (
        <span className={styles.hint}>{hint}</span>
      ) : null}
    </span>
  );
}
