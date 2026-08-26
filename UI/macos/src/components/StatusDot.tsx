import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './StatusDot.module.css';

/**
 * 五种语义，固定映射（DESIGN.md 第 4.1 节）：
 * ok 绿=正常、degraded 琥珀=降级、fail 红=失败、off 灰=未启用、current 青=当前。
 */
export type StatusTone = 'ok' | 'degraded' | 'fail' | 'off' | 'current';

/** 调用方常用的同义写法，一律折回上面五种语义，避免各视图各写一套颜色 */
export type StatusToneInput =
  | StatusTone
  | 'success'
  | 'running'
  | 'warn'
  | 'warning'
  | 'error'
  | 'danger'
  | 'idle'
  | 'disabled'
  | 'unknown'
  | 'neutral'
  | 'active';

const CANONICAL: Record<StatusToneInput, StatusTone> = {
  ok: 'ok',
  success: 'ok',
  running: 'ok',
  degraded: 'degraded',
  warn: 'degraded',
  warning: 'degraded',
  fail: 'fail',
  error: 'fail',
  danger: 'fail',
  off: 'off',
  idle: 'off',
  disabled: 'off',
  unknown: 'off',
  neutral: 'off',
  current: 'current',
  active: 'current',
};

const FALLBACK_TEXT: Record<StatusTone, string> = {
  ok: '正常',
  degraded: '降级',
  fail: '失败',
  off: '未启用',
  current: '当前',
};

interface StatusDotBase {
  /** 文字。状态不能只靠颜色表达（DESIGN.md 第 6 节），所以这里几乎总该给 */
  children?: ReactNode;
  /** children 的别名 */
  label?: ReactNode;
  /** 圆点变空心环，用于「已配置但未生效」这类弱化状态 */
  hollow?: boolean;
  title?: string;
  className?: string;
}

/** tone 与 status 指同一件事，二者必有其一 */
export type StatusDotProps = StatusDotBase &
  ({ tone: StatusToneInput; status?: StatusToneInput } | { status: StatusToneInput; tone?: StatusToneInput });

interface StatusDotResolved extends StatusDotBase {
  tone?: StatusToneInput;
  status?: StatusToneInput;
}

export function StatusDot(props: StatusDotProps) {
  const { tone, status, children, label, hollow = false, title, className } = props as StatusDotResolved;
  // 联合类型保证 tone 与 status 至少给了一个
  const canonical = CANONICAL[(tone ?? status) as StatusToneInput];
  const text = children ?? label;
  const missingText = text === null || text === undefined || text === '';
  return (
    <span className={cx(styles.root, className)} title={title}>
      <span className={cx(styles.dot, styles[canonical], hollow && styles.hollow)} aria-hidden="true" />
      {missingText ? (
        <span className={styles.srOnly}>{FALLBACK_TEXT[canonical]}</span>
      ) : (
        <span className={styles.text}>{text}</span>
      )}
    </span>
  );
}
