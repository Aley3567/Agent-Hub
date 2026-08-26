import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx, redactSecrets } from '../lib';
import { IconButton } from './IconButton';
import styles from './CodeBlock.module.css';

export interface CodeBlockProps {
  /** 代码内容；也可以直接放在 children 里（只接字符串） */
  code?: string | null;
  children?: string;
  /** 左上角标签，例如「实际执行的命令」 */
  label?: ReactNode;
  /** 是否给复制按钮，默认给 */
  copyable?: boolean;
  /** 超过这个高度就内部滚动 */
  maxHeight?: number;
  /** 自动换行；命令行默认横向滚动，长错误体建议打开 */
  wrap?: boolean;
  className?: string;
}

type CopyState = 'idle' | 'done' | 'fail';

const RESET_DELAY = 1600;

/**
 * 代码块。**渲染前一定过 redactSecrets**——README.md 的安全边界要求凭证绝不出现在界面上，
 * 这里是最后一道闸；复制出去的也是脱敏后的文本，不是原文。
 */
export function CodeBlock({
  code,
  children,
  label,
  copyable = true,
  maxHeight,
  wrap = false,
  className,
}: CodeBlockProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const raw = code ?? children ?? '';
  const safe = redactSecrets(raw);

  async function copy() {
    let next: CopyState = 'fail';
    try {
      await navigator.clipboard.writeText(safe);
      next = 'done';
    } catch {
      next = 'fail';
    }
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), RESET_DELAY);
  }

  return (
    <div className={cx(styles.root, className)}>
      {label === undefined && !copyable ? null : (
        <div className={styles.bar}>
          <span className={styles.label}>{label}</span>
          <span className={styles.status} aria-live="polite">
            {state === 'done' ? '已复制（凭证已脱敏）' : state === 'fail' ? '复制失败，系统剪贴板不可用' : ''}
          </span>
          {copyable ? (
            <IconButton
              icon="copy"
              aria-label="复制"
              tooltip="复制（复制出去的是脱敏后的文本）"
              onClick={copy}
            />
          ) : null}
        </div>
      )}
      <pre className={cx(styles.pre, wrap && styles.wrap)} style={maxHeight === undefined ? undefined : { maxHeight }}>
        <code className={styles.code}>{safe}</code>
      </pre>
    </div>
  );
}
