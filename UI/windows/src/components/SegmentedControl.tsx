import { cx } from '../lib';
import { Icon, type IconName } from './Icon';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** 悬浮标题，用来解释这一档的含义 */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** 整组的无障碍名，例如「推理档位」 */
  'aria-label'?: string;
  className?: string;
  /** 拉满容器宽度，每段等分 */
  fullWidth?: boolean;
  /** 标签过长时是否截断显示省略号；槽位 effort 控件为了不截字传 false */
  truncate?: boolean;
}

/**
 * 分段控件。承载两处固定场景：
 * effort 五档（未设置 / low / medium / high / xhigh）与主题三态（跟随系统 / 深色 / 浅色）。
 * 用 radiogroup 语义，左右方向键在段间移动（DESIGN.md 第 6 节：全部交互元素键盘可达）。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
  disabled = false,
  'aria-label': ariaLabel,
  className,
  fullWidth = false,
  truncate = true,
}: SegmentedControlProps<T>) {
  function move(step: number) {
    const enabled = options.filter((option) => option.disabled !== true);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((option) => option.value === value);
    const next = enabled[(current + step + enabled.length) % enabled.length];
    if (next && next.value !== value) onChange(next.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx(styles.root, styles[size], fullWidth && styles.full, disabled && styles.disabled, !truncate && styles.noTruncate, className)}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || option.disabled === true}
            className={cx(styles.segment, selected && styles.selected)}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {/* 不传 size：统一走 tokens.css 的 --icon-size 栅格（见 Icon.module.css 的说明） */}
            {option.icon ? <Icon name={option.icon} /> : null}
            <span className={cx(styles.label, truncate && styles.labelTruncate)}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
