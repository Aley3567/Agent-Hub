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
  /** sm 高 30、md 高 34（DESIGN.md 第 4.1 节 Button 行） */
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
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], fullWidth && styles.full, className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/* 图标与 Spinner 都不传 size：统一走 tokens.css 的 --icon-size 栅格，两者同边长，
          loading 切换时按钮宽度不跳 */}
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children === null || children === undefined || children === '' ? null : (
        <span className={styles.label}>{children}</span>
      )}
      {trailingIcon && !loading ? <Icon name={trailingIcon} /> : null}
    </button>
  );
}
