/**
 * 一个槽位的「渠道 + 模型」两级选择器。
 *
 * 可选项的边界不是我定的，是写入侧定的：set_hub_slot 只接受本 hub channels 里声明的渠道别名，
 * 且模型必须在该渠道声明的 models 里；claude-hub.py 读配置时会再校验一遍。所以：
 *   - 本 hub 已声明的渠道 → 可选；
 *   - 本机其他渠道（已过滤 hidden）→ 列出来但不可选，并说清「尚未加入本 hub」，
 *     而不是让用户点一下换回一句写入失败；
 *   - 没声明任何模型的 hub 渠道 → 同样列出但不可选，理由写在选项里。
 * 组件完全受控于 binding，不留本地草稿，界面上看到的永远是配置里的真实状态。
 */
import { Select } from '../../../components';
import type { Channel, HubChannel, SlotName } from '../../../types/contract';
import { firstDeclaredModel, findHubChannelByName, protocolLabel } from '../slotModel';
import styles from './SlotPicker.module.css';

export interface SlotPickerProps {
  slot: SlotName;
  /** 本 hub 声明的渠道 */
  hubChannels: HubChannel[];
  /** 本机可用但尚未加入本 hub 的渠道，只作提示 */
  undeclared: Channel[];
  /** hub 渠道背后的本机渠道，用来在选项里显示真名 */
  channelsById: Map<string, Channel>;
  /** 当前绑定，null 表示未绑定 */
  binding: { channel: string; model: string } | null;
  disabled: boolean;
  /** 提交一次改动：两个都为 null 表示清除绑定 */
  onCommit(channel: string | null, model: string | null): void;
}

export function SlotPicker({
  slot,
  hubChannels,
  undeclared,
  channelsById,
  binding,
  disabled,
  onCommit,
}: SlotPickerProps) {
  const channelValue = binding === null ? '' : binding.channel;
  const bound = findHubChannelByName(hubChannels, channelValue);
  const declared = bound === null ? [] : bound.models.map((model) => model.trim()).filter((model) => model !== '');
  /** 绑定里的渠道不在 hub channels 里（多半是手改过配置）：仍要如实显示出来 */
  const orphanChannel = binding !== null && bound === null ? binding.channel : null;
  /** 绑定里的模型不在声明列表里：同样如实显示，不假装它是合法值 */
  const orphanModel = binding !== null && !declared.includes(binding.model) ? binding.model : null;

  function handleChannel(next: string): void {
    if (next === '') {
      onCommit(null, null);
      return;
    }
    const target = findHubChannelByName(hubChannels, next);
    if (target === null) {
      // 只有「当前绑定但 hub 未声明」那一项会走到这里，选它等于什么都没改。
      return;
    }
    const keep = binding !== null && target.models.includes(binding.model) ? binding.model : null;
    const model = keep ?? firstDeclaredModel(target);
    if (model === null) {
      // 没声明模型的渠道在选项里就是 disabled，正常操作到不了这里。
      return;
    }
    onCommit(target.name, model);
  }

  function handleModel(next: string): void {
    if (next === '' || binding === null) return;
    onCommit(binding.channel, next);
  }

  const modelPlaceholder =
    binding === null
      ? '先选渠道'
      : declared.length === 0 && orphanModel === null
        ? '该渠道未声明模型'
        : undefined;

  return (
    <>
      <div className={styles.cell}>
        <span className={styles.label}>绑定渠道</span>
        <Select
          selectSize="sm"
          mono
          aria-label={`${slot} 槽位绑定的渠道`}
          value={channelValue}
          disabled={disabled}
          placeholder="未绑定（走 fallback）"
          onChange={(event) => handleChannel(event.target.value)}
        >
          <optgroup label="本 hub 已声明的渠道">
            {hubChannels.map((item) => {
              const real = item.resolvedChannelId === null ? null : channelsById.get(item.resolvedChannelId);
              const empty = item.models.length === 0;
              const suffix = empty
                ? '未声明模型，不能绑定'
                : real === undefined || real === null
                  ? `${protocolLabel(item.apiFormat)}·provider 未解析`
                  : `${protocolLabel(item.apiFormat)}·${real.name}`;
              return (
                <option key={item.name} value={item.name} disabled={empty}>
                  {`${item.name}（${suffix}）`}
                </option>
              );
            })}
          </optgroup>
          {orphanChannel === null ? null : (
            <optgroup label="当前绑定（本 hub 未声明，启动会报错）">
              <option value={orphanChannel}>{orphanChannel}</option>
            </optgroup>
          )}
          {undeclared.length === 0 ? null : (
            <optgroup label="本机其他渠道（尚未加入本 hub，不能直接绑定）">
              {undeclared.map((item) => (
                <option key={item.id} value={`undeclared:${item.id}`} disabled>
                  {`${item.name}（先写进本 hub 的 channels）`}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      <div className={styles.cell}>
        <span className={styles.label}>目标模型</span>
        <Select
          selectSize="sm"
          mono
          aria-label={`${slot} 槽位的目标模型`}
          value={binding === null ? '' : binding.model}
          disabled={disabled || binding === null}
          placeholder={modelPlaceholder}
          onChange={(event) => handleModel(event.target.value)}
        >
          {declared.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          {orphanModel === null ? null : (
            <option value={orphanModel}>{`${orphanModel}（本 hub 未声明）`}</option>
          )}
        </Select>
      </div>
    </>
  );
}
