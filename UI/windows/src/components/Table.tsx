import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Table.module.css';

export interface TableProps extends Omit<ComponentPropsWithRef<'table'>, 'children'> {
  children?: ReactNode;
  /** 外层横向滚动容器的类名 */
  wrapperClassName?: string;
  /** 长表格滚动时钉住表头 */
  stickyHeader?: boolean;
  /** 行高从 36 收到 30，用于详情里的副表 */
  dense?: boolean;
  /** 列多到放不下时给一个最小宽度，让外层横向滚动而不是挤压列 */
  minWidth?: number;
}

/**
 * 表格骨架。自带横向滚动容器——DESIGN.md 第 3 节要求页面 body 永不横向滚动，宽表自己滚。
 * 原生 thead / tbody / tr 也会被样式覆盖到，所以调用方按普通表格写就行，只在需要
 * 右对齐或等宽时换用 Th / Td 的 numeric、mono 属性。
 */
export function Table({
  children,
  wrapperClassName,
  stickyHeader = false,
  dense = false,
  minWidth,
  className,
  style,
  ...rest
}: TableProps) {
  return (
    <div className={cx(styles.scroll, wrapperClassName)}>
      <table
        className={cx(styles.table, stickyHeader && styles.sticky, dense && styles.dense, className)}
        style={minWidth === undefined ? style : { minWidth, ...style }}
        {...rest}
      >
        {children}
      </table>
    </div>
  );
}

export interface ThProps extends Omit<ComponentPropsWithRef<'th'>, 'align'> {
  /** 数字列：右对齐 + 等宽 */
  numeric?: boolean;
  align?: 'left' | 'center' | 'right';
}

export function Th({ numeric = false, align, className, children, scope = 'col', ...rest }: ThProps) {
  const resolved = align ?? (numeric ? 'right' : 'left');
  return (
    <th scope={scope} className={cx(styles.th, styles[`align-${resolved}`], className)} {...rest}>
      {children}
    </th>
  );
}

export interface TdProps extends Omit<ComponentPropsWithRef<'td'>, 'align'> {
  /** 数字列：右对齐 + 等宽 + tabular-nums */
  numeric?: boolean;
  /** 技术标识（模型 id、渠道名、降级码）转等宽 */
  mono?: boolean;
  align?: 'left' | 'center' | 'right';
  /** 超长内容单行截断，靠 title 兜住完整值 */
  truncate?: boolean;
}

export function Td({ numeric = false, mono = false, align, truncate = false, className, children, ...rest }: TdProps) {
  const resolved = align ?? (numeric ? 'right' : 'left');
  return (
    <td
      className={cx(
        styles.td,
        styles[`align-${resolved}`],
        (numeric || mono) && styles.mono,
        truncate && styles.truncate,
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
