/**
 * 别名编辑器。
 *
 * 别名冲突与保留字的判断在 Rust 侧（与 claude-provider-once.py 的 RESERVED_SELECTOR_WORDS
 * 同一份清单），所以这里不做本地校验去猜它的规则——直接把 IPC 返回的中文错误显示在
 * 编辑框下方，一个字都不改写（AGENTS.md：错误原样暴露）。
 */
import { useEffect, useId, useState } from 'react';
import { Button, Field, Input } from '../../../components';
import { errorText } from '../../../store';
import type { Channel } from '../../../types/contract';
import styles from './AliasEditor.module.css';

export interface AliasEditorProps {
  channel: Channel;
  /** 成功即 resolve，失败抛出中文原因 */
  onSave(alias: string | null): Promise<void>;
}

export default function AliasEditor({ channel, onSave }: AliasEditorProps) {
  const inputId = useId();
  const current = channel.alias ?? '';
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 写入成功后 store 会刷新渠道，别名变了就把草稿拉回持久化后的值
  useEffect(() => {
    setDraft(channel.alias ?? '');
    setError(null);
  }, [channel.alias]);

  const trimmed = draft.trim();
  const dirty = trimmed !== current;

  async function submit(next: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await onSave(next);
      setStatus(next === null ? '已清除别名，写入 claude1-config.json' : '已保存别名，写入 claude1-config.json');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || busy) return;
        void submit(trimmed === '' ? null : trimmed);
      }}
    >
      <Field
        label="别名"
        htmlFor={inputId}
        error={error}
        hint="设了别名就能直接 claude1 <别名> 启动。不能以「-」开头，也不能用 claude1 的保留命令。"
      >
        <div className={styles.row}>
          <Input
            id={inputId}
            value={draft}
            mono
            inputSize="sm"
            placeholder="未设置"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            invalid={error !== null}
            wrapperClassName={styles.input}
            onChange={(event) => {
              setDraft(event.target.value);
              setStatus(null);
            }}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!dirty}>
            保存
          </Button>
          {current === '' ? null : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void submit(null)}>
              清除
            </Button>
          )}
        </div>
      </Field>
      <span className={styles.status} aria-live="polite">
        {status}
      </span>
    </form>
  );
}
