/**
 * 对话视图底部 composer（DESIGN.md 4.5）。
 *
 * 输入区直接用 Textarea 原语（--bg-inset 底、--border-default 描边、focus 转 --accent，
 * §4.1 规范已在组件内实现）；发送是本视图主行动，用 Button primary。
 * 键位写死：Enter 发送、Shift+Enter 换行（不做设置项）；中文输入法组合中
 * （isComposing）的 Enter 是选词，不触发发送。
 *
 * sending / streaming 两档都是「真实流中」：sending 是已经发出、还没收到首个增量（按钮转
 * loading），streaming 是正文正在逐段到达（发送键禁用，等这一条说完）。两档都只反映
 * store 里的真实在途流，不再有本地模拟的渲染节奏。
 */
import { memo, useCallback, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { t } from '../../../i18n';
import { Button, Textarea } from '../../../components';
import styles from './Composer.module.css';

export interface ComposerProps {
  /** 整体禁用（没有选中会话，或选中的是只读会话） */
  disabled: boolean;
  /** 禁用是不是因为只读（历史回放）：只影响 placeholder 与提示行说什么 */
  readOnly: boolean;
  /** 已发出、还没有收到首个增量：发送键转 loading，仍允许继续起草 */
  sending: boolean;
  /** 正文正在逐段到达：发送不可用，等这一条说完 */
  streaming: boolean;
  onSend: (content: string) => void;
}

function Composer({ disabled, readOnly, sending, streaming, onSend }: ComposerProps) {
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

  const placeholder = readOnly
    ? t('这是历史会话的只读回放：不能发送。要接着问，新建一个本地会话。')
    : disabled
      ? t('先在左侧选一个会话')
      : t('说点什么，验证这条渠道是不是真的能用');

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
          placeholder={placeholder}
          aria-label={t('消息输入框')}
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
          title={t('发送 Enter')}
        >
          {t('发送')}
        </Button>
      </div>
      <p className={styles.keys}>
        {readOnly ? t('只读回放：这个会话来自历史项目，发送与删除都不开放') : t('Enter 发送 · Shift+Enter 换行')}
      </p>
    </div>
  );
}

export default memo(Composer);
