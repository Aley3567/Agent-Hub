import type { ReactNode } from 'react';
import { cx } from '../lib';
import { BrandMark } from './BrandMark';
import { Button, type ButtonVariant } from './Button';
import { Icon, type IconName } from './Icon';
import styles from './EmptyState.module.css';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: IconName;
  variant?: ButtonVariant;
  disabled?: boolean;
}

export interface EmptyStateProps {
  /** 一行标题，说清这里本该有什么 */
  title: string;
  /**
   * 为什么是空的。必填——DESIGN.md 第 4.1 节把「暂无数据」列为禁语：
   * 空态要么是本机还没产生数据，要么是筛选条件太窄，两者的下一步完全不同。
   */
  description: string;
  /** 一个明确的下一步，必填。没有动作可给时，至少给「刷新」或「清空筛选」 */
  action: EmptyStateAction;
  /** 次要动作 */
  secondaryAction?: EmptyStateAction;
  icon?: IconName;
  /** 补充说明，例如等价的 CLI 命令 */
  hint?: ReactNode;
  className?: string;
  /** 品牌 hero 变体：渐变 BrandMark + 标题 + 一句话定位 */
  hero?: boolean;
}

export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  icon = 'info',
  hint,
  className,
  hero = false,
}: EmptyStateProps) {
  return (
    <div className={cx(styles.root, hero && styles.rootHero, className)}>
      {hero ? (
        <span className={styles.heroMark}>
          <BrandMark size="lg" />
        </span>
      ) : (
        <span className={styles.icon}>
          {/* 不传 size：统一走 tokens.css 的 --icon-size（20px）栅格，外面那个
              --sp-10（40px）的圆底盘容得下 */}
          <Icon name={icon} />
        </span>
      )}
      <p className={cx(styles.title, hero && styles.titleHero)}>{title}</p>
      <p className={styles.description}>{description}</p>
      {hint === undefined ? null : <div className={styles.hint}>{hint}</div>}
      <div className={styles.actions}>
        <Button
          variant={action.variant ?? 'secondary'}
          size="sm"
          icon={action.icon}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
        {secondaryAction === undefined ? null : (
          <Button
            variant={secondaryAction.variant ?? 'ghost'}
            size="sm"
            icon={secondaryAction.icon}
            disabled={secondaryAction.disabled}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}
