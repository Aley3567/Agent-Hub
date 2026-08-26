import type { ComponentPropsWithRef } from 'react';
import { cx } from '../lib';
import styles from './Textarea.module.css';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean;
  /** 错误说明，渲染在下方（--fs-12） */
  error?: string | null;
  hint?: string | null;
  mono?: boolean;
  wrapperClassName?: string;
}

export function Textarea({
  invalid = false,
  error,
  hint,
  mono = false,
  wrapperClassName,
  className,
  rows = 4,
  ...rest
}: TextareaProps) {
  const hasError = invalid || (error !== null && error !== undefined && error !== '');
  return (
    <span className={cx(styles.wrap, wrapperClassName)}>
      <textarea
        className={cx(styles.textarea, mono && styles.mono, hasError && styles.invalid, className)}
        rows={rows}
        aria-invalid={hasError || undefined}
        {...rest}
      />
      {error !== null && error !== undefined && error !== '' ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : hint !== null && hint !== undefined && hint !== '' ? (
        <span className={styles.hint}>{hint}</span>
      ) : null}
    </span>
  );
}
