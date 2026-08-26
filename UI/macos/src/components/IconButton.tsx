import type { ComponentPropsWithRef } from 'react';
import { cx } from '../lib';
import { Icon, type IconName } from './Icon';
import { Tooltip, type TooltipSide } from './Tooltip';
import styles from './IconButton.module.css';

export type IconButtonVariant = 'ghost' | 'secondary' | 'danger';

interface IconButtonBase extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  /** 无障碍名，类型上必填：只有图标的按钮没有可见文字，这是唯一的名字来源 */
  'aria-label': string;
  variant?: IconButtonVariant;
  /** sm 为 30×30（DESIGN.md 基准），md 为 34×34，与同排 md 按钮对齐时用 */
  size?: 'sm' | 'md';
  /** 悬浮提示，默认复用 aria-label */
  tooltip?: string;
  tooltipSide?: TooltipSide;
  /** 处于激活状态（例如筛选已开启） */
  active?: boolean;
}

/** icon 与 name 指同一件事，二者必有其一 */
export type IconButtonProps = IconButtonBase &
  ({ icon: IconName; name?: IconName } | { name: IconName; icon?: IconName });

/** 收敛后的形状，只用于函数体内部读取，外部约束仍由 IconButtonProps 负责 */
interface IconButtonResolved extends IconButtonBase {
  icon?: IconName;
  name?: IconName;
}

export function IconButton(props: IconButtonProps) {
  const {
    icon,
    name,
    variant = 'ghost',
    size = 'sm',
    tooltip,
    tooltipSide = 'top',
    active = false,
    className,
    type = 'button',
    ...rest
  } = props as IconButtonResolved;
  // 联合类型保证 icon 与 name 至少给了一个
  const glyph = (icon ?? name) as IconName;
  const label = rest['aria-label'];
  return (
    <Tooltip content={tooltip ?? label} side={tooltipSide}>
      <button
        type={type}
        className={cx(styles.button, styles[variant], styles[size], active && styles.active, className)}
        aria-pressed={active || undefined}
        {...rest}
      >
        {/* 不传 size：统一走 tokens.css 的 --icon-size（20px）栅格，30×30 与 34×34 两档
            外框都容得下，图标线宽因此也保持同一档（见 Icon.module.css） */}
        <Icon name={glyph} />
      </button>
    </Tooltip>
  );
}
