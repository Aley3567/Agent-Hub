/**
 * 模型与 effort 的本地覆盖编辑器。
 *
 * 两个字段由同一个 IPC（set_channel_override）一起写，所以这里也一起提交——分两次写
 * 会让「只改了 effort」变成「顺手把模型清空」。写入目标只有 claude1-config.json，
 * 绝不碰 CC Switch 数据库（CONTRACT.md 第 3 节）。
 */
import { useEffect, useId, useState } from 'react';
import { Button, Field, Input, SegmentedControl } from '../../../components';
import { errorText } from '../../../store';
import type { Channel, Effort } from '../../../types/contract';
import { EFFORT_CHOICES, type EffortChoice } from '../model';
import styles from './OverrideEditor.module.css';

export interface OverrideEditorProps {
  channel: Channel;
  /** 成功即 resolve，失败抛出中文原因 */
  onSave(model: string | null, effort: Effort | null): Promise<void>;
}

export default function OverrideEditor({ channel, onSave }: OverrideEditorProps) {
  const inputId = useId();
  const currentModel = channel.modelOverride ?? '';
  const currentEffort: EffortChoice = channel.effortOverride ?? 'none';
  const [modelDraft, setModelDraft] = useState(currentModel);
  const [effortDraft, setEffortDraft] = useState<EffortChoice>(currentEffort);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 写入成功后 store 会刷新渠道，覆盖值变了就把草稿拉回持久化后的值
  useEffect(() => {
    setModelDraft(channel.modelOverride ?? '');
    setEffortDraft(channel.effortOverride ?? 'none');
    setError(null);
  }, [channel.effortOverride, channel.modelOverride]);

  const trimmed = modelDraft.trim();
  const dirty = trimmed !== currentModel || effortDraft !== currentEffort;
  const hasOverride = channel.modelOverride !== null || channel.effortOverride !== null;

  async function submit(model: string | null, effort: Effort | null): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await onSave(model, effort);
      setStatus(
        model === null && effort === null
          ? '已清除覆盖，写入 claude1-config.json'
          : '已保存覆盖，写入 claude1-config.json',
      );
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
        void submit(trimmed === '' ? null : trimmed, effortDraft === 'none' ? null : effortDraft);
      }}
    >
      <Field
        label="覆盖模型"
        htmlFor={inputId}
        hint={
          channel.declaredModel === null
            ? '留空表示不覆盖；这个渠道自己也没声明模型。'
            : `留空表示不覆盖，启动时用渠道声明的 ${channel.declaredModel}。`
        }
      >
        <Input
          id={inputId}
          value={modelDraft}
          mono
          inputSize="sm"
          placeholder="未覆盖"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          invalid={error !== null}
          wrapperClassName={styles.input}
          onChange={(event) => {
            setModelDraft(event.target.value);
            setStatus(null);
          }}
        />
      </Field>

      <Field label="effort 档位" hint="覆盖 settings_config 的 effortLevel；未设置就不写这个环境变量。">
        <SegmentedControl
          options={EFFORT_CHOICES}
          value={effortDraft}
          aria-label="effort 档位"
          disabled={busy}
          onChange={(value) => {
            setEffortDraft(value);
            setStatus(null);
          }}
        />
      </Field>

      <div className={styles.row}>
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!dirty}>
          保存覆盖
        </Button>
        {hasOverride ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void submit(null, null)}>
            清除覆盖
          </Button>
        ) : null}
      </div>

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <span className={styles.status} aria-live="polite">
        {status}
      </span>
    </form>
  );
}
