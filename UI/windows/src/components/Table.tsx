import { Children, Fragment, isValidElement } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx, redactSecrets } from '../lib';
import styles from './Table.module.css';

export interface TableProps extends Omit<ComponentPropsWithRef<'table'>, 'children'> {
  children?: ReactNode;
  /** 外层横向滚动容器的类名 */
  wrapperClassName?: string;
  /** 长表格滚动时钉住表头 */
  stickyHeader?: boolean;
  /** 行高从 40（--row-h）收到 34（--control-h-md），用于详情里的副表 */
  dense?: boolean;
  /** 列多到放不下时给一个最小宽度，让外层横向滚动而不是挤压列 */
  minWidth?: number;
  /**
   * 是否画 1px --border-default 外轮廓（DESIGN.md 4.1.1「表格外框」）。默认画。
   * 已经被 flush 的 Card 包住时传 false，免得两条 1px 线贴在一起。
   */
  framed?: boolean;
  /**
   * 列宽策略。不传时按「有没有 <colgroup>」自动决定：有就 fixed（让 colgroup 的宽度成为
   * 硬约束），没有就 auto（保持靠内容 + minWidth 分配列宽的老行为）。
   * 自动判断只看直接子节点与 Fragment 里的 <colgroup>，包在自定义组件里时手动传 'fixed'。
   */
  layout?: 'auto' | 'fixed';
}

/** 只认直接子节点与 Fragment 里的 <colgroup>——再深就交给调用方显式传 layout */
function hasColgroup(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false;
    if (child.type === 'colgroup') return true;
    if (child.type === Fragment) return hasColgroup((child.props as { children?: ReactNode }).children);
    return false;
  });
}

/**
 * 表格骨架。自带横向滚动容器——DESIGN.md 第 3 节要求页面 body 永不横向滚动，宽表自己滚。
 * 原生 thead / tbody / tr 也会被样式覆盖到，所以调用方按普通表格写就行，只在需要
 * 右对齐或等宽时换用 Th / Td 的 numeric、mono 属性。
 * 列宽按 DESIGN.md 4.1.1 由调用方用 <colgroup> 声明，宽度取 --table-col-* token。
 */
export function Table({
  children,
  wrapperClassName,
  stickyHeader = false,
  dense = false,
  minWidth,
  framed = true,
  layout,
  className,
  style,
  ...rest
}: TableProps) {
  const resolvedLayout = layout ?? (hasColgroup(children) ? 'fixed' : 'auto');
  return (
    <div className={cx(styles.scroll, !framed && styles.unframed, wrapperClassName)}>
      <table
        className={cx(
          styles.table,
          stickyHeader && styles.sticky,
          dense && styles.dense,
          resolvedLayout === 'fixed' && styles.fixed,
          className,
        )}
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
  /** 操作列表头：钉在右侧，不透明底 + 左侧分隔线（DESIGN.md 4.1.1「sticky 操作列」） */
  stickyAction?: boolean;
}

export function Th({
  numeric = false,
  align,
  stickyAction = false,
  className,
  children,
  scope = 'col',
  ...rest
}: ThProps) {
  const resolved = align ?? (numeric ? 'right' : 'left');
  return (
    <th
      scope={scope}
      className={cx(styles.th, styles[`align-${resolved}`], stickyAction && styles.stickyAction, className)}
      {...rest}
    >
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
  /** 操作列单元格：钉在右侧，不透明底 + 左侧分隔线 + 向左的渐变 */
  stickyAction?: boolean;
  /**
   * 该行是当前行/选中行。只影响 stickyAction 的底色：换成 --bg-selected-table-solid，
   * 即半透明的 --bg-selected-table 叠在 --bg-base 上的不透明等价色。
   * 行底本身由视图自己涂（channels 的 .currentRow 用的就是 --bg-selected-table），
   * 这里必须显式传——tr[aria-selected] 的行底是另一个 token，不做隐式映射。
   */
  currentRow?: boolean;
}

export function Td({
  numeric = false,
  mono = false,
  align,
  truncate = false,
  stickyAction = false,
  currentRow = false,
  className,
  children,
  ...rest
}: TdProps) {
  const resolved = align ?? (numeric ? 'right' : 'left');
  return (
    <td
      className={cx(
        styles.td,
        styles[`align-${resolved}`],
        (numeric || mono) && styles.mono,
        truncate && styles.truncate,
        stickyAction && styles.stickyAction,
        stickyAction && currentRow && styles.stickyActionCurrent,
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export interface MidTruncateProps extends Omit<ComponentPropsWithRef<'span'>, 'children' | 'title'> {
  /** 完整值。显示串从它裁出来，title 挂的仍是完整值 */
  value: string;
  /** 尾部保留的字符数，默认 8——claude-opus-4-1-20250805 的日期戳正好 8 位 */
  tail?: number;
  /** 覆盖 title；不传就用完整值 */
  title?: string;
}

/**
 * 中截断：头尾都留，中间用 … （DESIGN.md 4.1.1「模型名列」）。
 * 纯 CSS 双 span——前段可收缩并由 text-overflow 吃掉溢出，后段 nowrap 且不收缩，所以尾部
 * 的日期戳不会被砍掉；砍尾部会把两个不同模型显示成同一个，这是这条需求的全部意义。
 * 不裁字符的好处：DOM 里两段拼起来仍是完整原串，不是「claude-opus…」这种带真省略号的
 * 残串——需要完整值的地方（title、后续要补的复制按钮）都能拿到。
 * 但**别把它当成「选中拖蓝复制就一定拿到完整 id」**：.midTruncate 是 display: flex，
 * 两个 span 是块级 flex item，跨兄弟块级盒的选区在纯文本序列化时通常会插入换行，
 * 手工选中复制多半得到 `claude-opus-4-1-\n20250805`。要保证复制正确得走显式复制按钮
 * （DESIGN.md 4.1.1「模型名列」记为待办）。
 */
export function MidTruncate({ value, tail = 8, title, className, ...rest }: MidTruncateProps) {
  // CONTRACT.md 1.2 凭证脱敏（fail-closed）：这是新增的文本展示路径，显示串与 title 都得过一遍
  const full = redactSecrets(value);
  // 按码点切，别把代理对切成两半
  const chars = Array.from(full);
  const keep = Math.min(Math.max(Math.trunc(tail), 0), chars.length);
  const head = chars.slice(0, chars.length - keep).join('');
  const rear = chars.slice(chars.length - keep).join('');
  return (
    <span
      className={cx(styles.midTruncate, className)}
      title={title === undefined ? full : redactSecrets(title)}
      {...rest}
    >
      {head === '' ? null : <span className={styles.midTruncateHead}>{head}</span>}
      {rear === '' ? null : <span className={styles.midTruncateTail}>{rear}</span>}
    </span>
  );
}
