/**
 * 单个插件项的一行。行结构按 DESIGN.md 4.6：
 * StatusDot + 名称（mono --fs-14）+ kind Badge + 一行 summary + 右侧操作位。
 *
 * 可写与只读的分叉（同一节）：
 *   - 全局项（scope 'global'）：右侧 Switch，切换直通 store.setPluginEnabled（成功后
 *     store 自动 refresh('plugins')）；失败把原因原文推进 toast.error，不就地吞掉。
 *   - 渠道项（scope 'channel'）：只读。不给禁用的 Switch——禁用开关暗示「满足某条件
 *     就能开」，而渠道级项在这里永远不可开。改用琥珀点 + 「只读」字样 + Tooltip
 *     三重编码（DESIGN.md 6：状态不只靠颜色）。
 *
 * detail 非空时行可展开，展开内容用 CodeBlock——它内部渲染前强制过 redactSecrets，
 * 是凭证不出现在界面上的最后一道闸（fail-closed，hooks 的 command 里可能带 token，
 * CONTRACT.md 1.2）。
 */
import { useEffect, useId, useState } from 'react';
import { Badge, CodeBlock, Icon, StatusDot, Switch, Tooltip } from '../../../components';
import { cx } from '../../../lib';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import type { PluginItem } from '../../../types/contract';
import styles from './PluginRow.module.css';

export interface PluginRowProps {
  item: PluginItem;
}

export default function PluginRow({ item }: PluginRowProps) {
  const setPluginEnabled = useApp((state) => state.setPluginEnabled);
  const toastError = useToast((state) => state.error);

  const readOnly = item.scope === 'channel';
  const hasDetail = item.detail !== null && item.detail !== '';

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyId = useId();

  /**
   * 展开面板的入场（DESIGN.md 2.5 时长语义表：面板入场 = --dur-normal）。
   * 与体检视图 CheckRow 同一个办法：条件挂载那一帧 transition 不触发，先挂
   * .bodyEnter 当起点，挂载后隔一帧摘掉；关键帧白名单不许视图新增 @keyframes，
   * 这是不越界又能让「刚展开的是这一块」被看见的办法。
   */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!(hasDetail && open)) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [hasDetail, open]);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await setPluginEnabled(item.id, next);
    } catch (cause) {
      // 原因原文（含渠道级只读的中文说明）进 toast；error.setPluginEnabled 里也有同一份
      toastError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  // StatusDot 语义沿用 DESIGN.md 4.1 既有映射，不新增：绿=启用、灰=未启用、琥珀=只读不可改
  const tone = readOnly ? 'degraded' : item.enabled ? 'ok' : 'off';
  const statusText = item.enabled ? '已启用' : '未启用';

  const main = (
    <>
      <StatusDot tone={tone} className={styles.status}>
        {statusText}
      </StatusDot>
      <span className={styles.name} title={item.name}>
        {item.name}
      </span>
      {/* Badge 装的是技术标识：组头已给中文组名，这里放机器码原值（人话在前、原码不隐藏） */}
      <Badge tone="neutral">{item.kind}</Badge>
      <span className={styles.summary} title={item.summary}>
        {item.summary}
      </span>
      {hasDetail ? (
        // 一枚箭头旋转到位，不换图标名：旋转能被看见，换名是硬切
        <Icon name="chevron-right" size={16} className={cx(styles.chevron, open && styles.chevronOpen)} />
      ) : null}
    </>
  );

  return (
    <li className={styles.row}>
      <div className={styles.line}>
        {hasDetail ? (
          <button
            type="button"
            className={styles.trigger}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
          >
            {main}
          </button>
        ) : (
          <div className={styles.static}>{main}</div>
        )}

        <div className={styles.action}>
          {readOnly ? (
            // 只读原因由 Tooltip 承载；「只读」字样本身不藏，读屏与扫读都能拿到
            <Tooltip content="来自渠道的 settings_config，桌面端对数据库只读；要调整到渠道视图或 CC Switch 里改">
              <span className={styles.readOnly}>只读</span>
            </Tooltip>
          ) : (
            <Switch
              checked={item.enabled}
              disabled={busy}
              aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
              onChange={(next) => void toggle(next)}
            />
          )}
        </div>
      </div>

      {hasDetail && open ? (
        <div className={cx(styles.body, !entered && styles.bodyEnter)} id={bodyId}>
          <CodeBlock label="原始配置（渲染前已脱敏）" code={item.detail} wrap maxHeight={240} />
        </div>
      ) : null}
    </li>
  );
}
