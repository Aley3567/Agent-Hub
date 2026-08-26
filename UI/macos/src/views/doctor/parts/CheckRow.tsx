/**
 * 单条体检结论。
 *
 * 失败与警告项默认展开——原因和建议动作是这一页真正要读的东西，不该藏在一次点击后面。
 * detail 里混着本机路径与上游文本，渲染前过一遍前端兜底脱敏（CONTRACT.md 1.2）。
 */
import { useEffect, useId, useState } from 'react';
import { Button, Icon, StatusDot, type StatusToneInput } from '../../../components';
import { cx, redactSecrets } from '../../../lib';
import type { DoctorCheck, DoctorLevel } from '../../../types/contract';
import styles from './CheckRow.module.css';

/** 三档结论的人话标签。DoctorLevel 的 info 在界面上叫「警告」：它不算失败，但会改变行为 */
export const LEVEL_LABEL: Record<DoctorLevel, string> = {
  ok: '通过',
  info: '警告',
  fail: '失败',
};

/** 状态点语义映射（DESIGN.md 4.1：绿=正常、琥珀=降级、红=失败），info 档在界面上按「警告」呈现 */
export const LEVEL_TONE: Record<DoctorLevel, StatusToneInput> = {
  ok: 'ok',
  info: 'degraded',
  fail: 'fail',
};

export interface CheckRowProps {
  check: DoctorCheck;
  /** 默认是否展开。失败与警告项传 true */
  defaultOpen: boolean;
  /** 桌面端是否接了这条修复动作的 IPC。没接就只给 CLI 指引，不放假按钮 */
  canFix: boolean;
  /** 点修复：由视图根弹确认框，这里只负责发出请求 */
  onFix: (check: DoctorCheck) => void;
  /** 这一项的修复正在跑 */
  fixing: boolean;
  /** 这一项修复失败的中文原因原文 */
  fixError: string | null;
}

export default function CheckRow({ check, defaultOpen, canFix, onFix, fixing, fixError }: CheckRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  const detail = redactSecrets(check.detail);
  const hasFix = check.fixAction !== null;
  const hasBody = detail !== '' || hasFix || fixError !== null;
  const bodyOpen = hasBody && open;

  /**
   * 展开面板的入场（DESIGN.md 2.5 时长语义表：面板入场 = --dur-normal）。
   * 面板是条件挂载的，transition 不会在挂载那一帧触发，所以先挂上 .bodyEnter 当起点，
   * 挂载后隔一帧摘掉，让 CSS 把它过渡回基态。DESIGN.md 2.5 的关键帧白名单不许视图自己
   * 新增关键帧，这是不越界又能让「刚展开的是这一块」被看见的办法。
   * 起点只有 4px 位移与透明度，rAF 万一被推迟（页签隐藏）也只是晚一点淡入，不会丢内容。
   */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!bodyOpen) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [bodyOpen]);

  const head = (
    <>
      <StatusDot tone={LEVEL_TONE[check.level]} className={styles.dot}>
        <span className={styles.title}>{check.title}</span>
      </StatusDot>
      <span className={styles.tail}>
        <code className={styles.id}>{check.id}</code>
        <span className={styles.level}>{LEVEL_LABEL[check.level]}</span>
        {hasBody ? (
          // 一枚箭头旋转到位，不换图标名：旋转能被看见，换名是硬切（样式见 .chevron / .chevronOpen）
          <Icon
            name="chevron-right"
            size={16}
            className={cx(styles.chevron, open && styles.chevronOpen)}
          />
        ) : null}
      </span>
    </>
  );

  return (
    <li className={styles.row}>
      {hasBody ? (
        <button
          type="button"
          className={styles.trigger}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {head}
        </button>
      ) : (
        <div className={styles.static}>{head}</div>
      )}

      {bodyOpen ? (
        <div className={cx(styles.body, !entered && styles.bodyEnter)} id={bodyId}>
          {detail === '' ? null : <p className={styles.detail}>{detail}</p>}

          {hasFix ? (
            canFix ? (
              <div className={styles.fix}>
                <Button variant="primary" size="sm" icon="check" loading={fixing} onClick={() => onFix(check)}>
                  清理并重新体检
                </Button>
                <span className={styles.fixHint}>点了会先弹确认框，说清会备份什么、清掉什么。</span>
              </div>
            ) : (
              <p className={styles.fixHint}>
                这一项的修复动作是 <code className={styles.id}>{check.fixAction}</code>
                ，桌面端没有接这条命令，请用 CLI 执行。
              </p>
            )
          ) : null}

          {fixError === null ? null : (
            <p className={styles.fixError} role="alert">
              {fixError}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}
