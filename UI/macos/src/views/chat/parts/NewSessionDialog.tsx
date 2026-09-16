/**
 * 新建本地会话（DESIGN.md 4.5）：选一个渠道、选一个 hub。
 *
 * 渠道列表取 store 的 channels（只列 claude 应用；codex 渠道不在这条 hub 链路上），既没有
 * 本地模型覆盖也没有声明模型的渠道置灰——Rust 侧新建时会直接报「解不出模型」，与其让它
 * 变成一次失败，不如在选项上就说清；隐藏渠道照列，但标出来是隐藏的。
 * hub 选项里空前缀那一项就是「默认 hub」，传给后端的是 null。
 *
 * 失败原因留在弹窗里：这是表单，错误属于当前这次输入，不该只闪一个 toast 就消失。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Field, Select } from '../../../components';
import { bilingual as b, t } from '../../../i18n';
import { errorText, useApp } from '../../../store';
import type { ChatSession } from '../../../types/contract';
import styles from './NewSessionDialog.module.css';

export interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  /** 建好了：把新会话交给调用方（视图据此选中它） */
  onCreated: (session: ChatSession) => void;
}

/** 渠道选项：别名放括号里，没有模型的置灰，隐藏的标出来源 */
function channelLabel(name: string, alias: string | null, hidden: boolean): string {
  const suffix = hidden ? b(t(" · 已隐藏"), ' · hidden') : '';
  return alias === null ? `${name}${suffix}` : `${name} (${alias})${suffix}`;
}

function NewSessionDialog({ open, onClose, onCreated }: NewSessionDialogProps) {
  const channels = useApp((state) => state.channels);
  const hubs = useApp((state) => state.hubs);
  const createChatSession = useApp((state) => state.createChatSession);

  const [channelId, setChannelId] = useState('');
  const [hubName, setHubName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const channelOptions = useMemo(
    () =>
      channels
        .filter((channel) => channel.appType === 'claude')
        .map((channel) => ({
          value: channel.id,
          label: channelLabel(channel.name, channel.alias, channel.hidden),
          // Rust 侧模型解析只用本地覆盖与声明模型，两个都没有就必然报错
          disabled: (channel.modelOverride ?? channel.declaredModel ?? '').trim() === '',
        })),
    [channels],
  );

  const hubOptions = useMemo(
    () => hubs.map((hub) => ({ value: hub.name, label: hub.name })),
    [hubs],
  );

  /** 每次打开都是一张新表单：上一次的失败原因与选择不带进来 */
  useEffect(() => {
    if (!open) return;
    setHubName('');
    setFailure(null);
    setBusy(false);
    setChannelId(channelOptions.find((option) => option.disabled !== true)?.value ?? '');
  }, [open, channelOptions]);

  const submit = async (): Promise<void> => {
    if (channelId === '' || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // hubName 空串 = 跟默认 hub：契约里 null 就是这个意思
      const session = await createChatSession(hubName === '' ? null : hubName, channelId);
      onCreated(session);
    } catch (cause) {
      setFailure(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('新建会话')}
      description={t('新会话通过 hub 发到渠道的上游，是真请求；建好之后左侧列表里就有它。')}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="sm" icon="send" loading={busy} disabled={channelId === ''} onClick={() => void submit()}>
            {t('新建并选中')}
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <Field label={t('会话绑定的渠道')} hint={t('模型取自渠道的本地覆盖或 settings_config 声明；两处都没有的渠道置灰')}>
          <Select
            items={channelOptions}
            value={channelId}
            placeholder={t('选一个渠道')}
            onChange={(event) => setChannelId(event.target.value)}
          />
        </Field>
        <Field label={t('hub')} hint={t('不选则用默认 hub')}>
          <Select
            items={hubOptions}
            value={hubName}
            placeholder={t('默认 hub')}
            onChange={(event) => setHubName(event.target.value)}
          />
        </Field>
        {failure === null ? null : (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export default NewSessionDialog;
