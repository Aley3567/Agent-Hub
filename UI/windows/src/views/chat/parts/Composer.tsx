/**
 * 对话视图底部 composer（DESIGN.md 4.5）。
 *
 * 输入区直接用 Textarea 原语（--bg-inset 底、--border-default 描边、focus 转 --accent，
 * §4.1 规范已在组件内实现）；发送是本视图主行动，用 Button primary。
 * 键位写死：Enter 发送、Shift+Enter 换行（不做设置项）；中文输入法组合中
 * （isComposing）的 Enter 是选词，不触发发送。
 */
import { memo, useCallback, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Textarea } from '../../../components';
import styles from './Composer.module.css';

export interface ComposerProps {
  /** 没有选中会话时整体禁用 */
  disabled: boolean;
  /** 等待回复中（思考态）：发送键转 loading，仍允许继续起草 */
  sending: boolean;
  /** 回复逐字渲染中：发送不可用，等这一条说完 */
  streaming: boolean;
  onSend: (content: string) => void;
}

function Composer({ disabled, sending, streaming, onSend }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** 随内容长高，上限由 CSS 的 max-height 封住（约 6 行） */
  const autoresize = useCallback((): void => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const canSend = !disabled && !sending && !streaming && draft.trim() !== '';

  const submit = (): void => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft('');
    // 清空后收回单行高度；等一帧让 React 先把 value 写进 DOM 再量 scrollHeight
    requestAnimationFrame(autoresize);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.composer}>
      <div className={styles.row}>
        <Textarea
          ref={inputRef}
          className={styles.input}
          wrapperClassName={styles.inputWrap}
          rows={1}
          value={draft}
          placeholder={disabled ? '先在左侧选一个会话' : '说点什么，验证这条渠道是不是真的能用'}
          aria-label="消息输入框"
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            autoresize();
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          variant="primary"
          size="md"
          icon="send"
          loading={sending}
          disabled={!canSend}
          onClick={submit}
          title="发送 Enter"
        >
          发送
        </Button>
      </div>
      <p className={styles.keys}>Enter 发送 · Shift+Enter 换行</p>
    </div>
  );
}

export default memo(Composer);
