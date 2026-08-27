import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { cx } from '../lib';
import { IconButton } from './IconButton';
import styles from './Dialog.module.css';
export interface DialogProps {
  open: boolean;
  /** Esc、遮罩点击、右上角关闭都走这里 */
  onClose: () => void;
  title: string;
  /** 标题下的一句说明，讲清这个操作会做什么 */
  description?: ReactNode;
  children?: ReactNode;
  /** 底部动作区，通常右对齐 */
  footer?: ReactNode;
  /** 点遮罩是否关闭，默认关闭；破坏性确认可以关掉 */
  closeOnOverlay?: boolean;
  className?: string;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  );
}

/**
 * 居中弹窗：最大宽 520、遮罩 rgba(0,0,0,.5)、Esc 关闭、焦点陷阱、
 * 打开时焦点进第一个可聚焦元素、关闭后焦点还给触发者（DESIGN.md 第 4.1 与第 6 节）。
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  closeOnOverlay = true,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  // onClose 进 ref 而不是 effect 依赖：消费方都传内联箭头函数，身份随父组件每次
  // 重渲染变化（tasks 视图有 30s 倒计时定时器），进了依赖数组会让 effect 周期性
  // 重跑——cleanup 把焦点还给 restoreTo、setup 又抢回第一个输入框，对话框开着
  // 超过一个定时器周期，正在打字的焦点就被拽走；restoreTo 还会被重捕获成面板内
  // 元素，关闭后焦点落到已卸载节点。开/关行为只应取决于 open。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const restoreTo = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = focusableIn(panel)[0];
      (first ?? panel).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      // IME 组合中的 Esc 是取消候选词，不是关闭对话框（Composer 同款守卫）
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = panelRef.current;
      if (!node) return;
      const items = focusableIn(node);
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (restoreTo && typeof restoreTo.focus === 'function') restoreTo.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (closeOnOverlay && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={cx(styles.panel, className)}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {description === undefined ? null : (
              <p className={styles.description} id={descriptionId}>
                {description}
              </p>
            )}
          </div>
          <IconButton icon="close" aria-label="关闭" onClick={onClose} />
        </div>
        {children === undefined ? null : <div className={styles.body}>{children}</div>}
        {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
