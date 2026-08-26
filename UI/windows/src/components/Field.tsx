import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './Field.module.css';

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** 常态说明，仅在没有 error 时显示 */
  hint?: ReactNode;
  /** 错误原因原文（IPC 返回的中文错误直接放进来，不要改写） */
  error?: string | null;
  /** 关联到控件的 id；给了才渲染真正的 <label for> */
  htmlFor?: string;
  required?: boolean;
  /** 标签在左、控件在右的横排布局 */
  inline?: boolean;
  className?: string;
}

/** 表单行：标签 + 控件 + 说明/错误。错误一律原样显示（AGENTS.md：错误原样暴露） */
export function Field({
  label,
  children,
  hint,
  error,
  htmlFor,
  required = false,
  inline = false,
  className,
}: FieldProps) {
  const labelContent = (
    <>
      {label}
      {required ? (
        <span className={styles.required} aria-hidden="true">
          *
        </span>
      ) : null}
    </>
  );
  const hasError = error !== null && error !== undefined && error !== '';
  return (
    <div className={cx(styles.field, inline && styles.inline, className)}>
      {htmlFor === undefined ? (
        <span className={styles.label}>{labelContent}</span>
      ) : (
        <label className={styles.label} htmlFor={htmlFor}>
          {labelContent}
        </label>
      )}
      <div className={styles.control}>
        {children}
        {hasError ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : hint === undefined || hint === null || hint === '' ? null : (
          <span className={styles.hint}>{hint}</span>
        )}
      </div>
    </div>
  );
}
