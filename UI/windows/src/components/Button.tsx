import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../lib';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** 默认 secondary：一屏里只有真正要行动的那一个用 primary（DESIGN.md 第 1 节） */
  variant?: ButtonVariant;
  /** sm 高 28、md 高 32 */
  size?: ButtonSize;
  icon?: IconName;
  trailingIcon?: IconName;
  /** 进行中：禁用点击并把前置图标换成 Spinner */
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  trailingIcon,
  loading = false,
  fullWidth = false,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 13 : 14;
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], fullWidth && styles.full, className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children === null || children === undefined || children === '' ? null : (
        <span className={styles.label}>{children}</span>
      )}
      {trailingIcon && !loading ? <Icon name={trailingIcon} size={iconSize} /> : null}
    </button>
  );
}
