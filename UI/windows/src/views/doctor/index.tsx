/**
 * 本机体检视图，回答「本机配置有没有问题，只读不联网」（CONTRACT.md 6.5 的文案锚点）。
 *
 * 三件事在这一页是硬要求：
 *   1. 总结论区用 aria-live="polite" 播报（DESIGN.md 6 节）；
 *   2. 「只读不联网」只说检查本身——run_doctor 纯本地只读；页面上唯一的修复动作会写
 *      本机文件，所以顶部声明把它单独说清（先备份、确认后才执行），不让「只读」两个字
 *      覆盖掉写操作的存在；
 *   3. 修复动作（清理子代理模型固定值）必须先确认、说清会备份什么，跑完自动重跑体检。
 *
 * 修复走 store 的 doctorFixSubagentPins：直通 IPC，成功时返回值就是修复后的完整体检结果，
 * store 直接落 state.doctor 并把 loadedKeys.doctor 标成已加载；失败原因原文记在
 * error.doctorFixSubagentPins，由对应行就地呈现（持久记录），同时与成功结论一样走
 * toast + 播报做即时反馈（REDESIGN-PROMPT 2.3 第 5 条：反馈统一走 toast）。
 * 按钮 busy 态用局部 fixingId——一次性动作的通行做法，不在视图里再开一套修复状态机。
 */
import { useMemo, useState } from 'react';
import { Button, Dialog, EmptyState, Icon, SectionHeader, Spinner, StatusDot } from '../../components';
import { useAnnouncer } from '../../shell/announce';
import { errorText, useApp } from '../../store';
import { useToast } from '../../store/toast';
import type { DoctorCheck, DoctorLevel } from '../../types/contract';
import CheckRow, { LEVEL_LABEL, LEVEL_TONE } from './parts/CheckRow';
import styles from './index.module.css';

/** 桌面端接了的修复动作。DoctorCheck.fixAction 给的是 IPC 名（CONTRACT.md 2 节） */
const FIX_SUBAGENT_PINS = 'doctor_fix_subagent_pins';

/** 分组顺序：要处理的在最上面，通过的在最下面。组内保持 run_doctor 给的话题顺序 */
const GROUP_ORDER: DoctorLevel[] = ['fail', 'info', 'ok'];

const GROUP_CAPTION: Record<DoctorLevel, string> = {
  fail: '这几项现在就会影响会话，先处理它们',
  info: '不算失败，但会改变行为或者让数据缺一块',
  ok: '本机这部分配置没有问题',
};

export default function DoctorView() {
  const checks = useApp((state) => state.doctor);
  const loading = useApp((state) => state.loading.doctor === true);
  const reason = useApp((state) => state.error.doctor ?? null);
  const loaded = useApp((state) => state.loadedKeys.doctor === true);
  const refresh = useApp((state) => state.refresh);
  const fixSubagentPins = useApp((state) => state.doctorFixSubagentPins);
  const fixReason = useApp((state) => state.error.doctorFixSubagentPins ?? null);
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);
  const announce = useAnnouncer((state) => state.announce);

  const [pending, setPending] = useState<DoctorCheck | null>(null);
  const [fixingId, setFixingId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const out: Record<DoctorLevel, DoctorCheck[]> = { fail: [], info: [], ok: [] };
    for (const check of checks) out[check.level].push(check);
    return out;
  }, [checks]);

  const total = checks.length;
  const failCount = grouped.fail.length;
  const warnCount = grouped.info.length;
  const okCount = grouped.ok.length;

  // 计数为零的档不进结论文本：「失败 0 项」是没有信息量的噪声
  const conclusion =
    total === 0
      ? '还没有体检结果'
      : failCount === 0 && warnCount === 0
        ? `${total} 项全部通过`
        : [
            `共 ${total} 项`,
            warnCount > 0 ? `警告 ${warnCount} 项` : null,
            failCount > 0 ? `失败 ${failCount} 项` : null,
          ]
            .filter((part): part is string => part !== null)
            .join('，');
  const conclusionTone: DoctorLevel | null = total === 0 ? null : failCount > 0 ? 'fail' : warnCount > 0 ? 'info' : 'ok';

  /** 即时结论同时进 toast 与播报区；失败时原因原文还会留在对应行里（fixReason） */
  function reportFix(text: string, ok: boolean): void {
    if (ok) toastSuccess(text);
    else toastError(text);
    announce(text);
  }

  async function runFix(target: DoctorCheck) {
    setPending(null);
    setFixingId(target.id);
    try {
      const fresh = await fixSubagentPins();
      const after = fresh.find((item) => item.id === target.id) ?? null;
      reportFix(
        after === null
          ? '清理跑完了：重跑的体检里已经没有这一项。'
          : after.level === 'fail'
            ? `清理跑完了，但「${after.title}」仍然是失败，展开这一项看原因。`
            : `清理跑完了，「${after.title}」现在是${LEVEL_LABEL[after.level]}。`,
        true,
      );
    } catch (cause) {
      // 原因原文不包装成「操作失败」；持久的一份由对应行读 error.doctorFixSubagentPins 就地呈现
      reportFix(`清理未成功：${errorText(cause)}`, false);
    } finally {
      setFixingId(null);
    }
  }

  return (
    <div className={styles.view}>
      <p className={styles.scope}>
        <Icon name="lock" size={14} className={styles.scopeIcon} />
        检查只读本机配置，不连任何上游：每条结论都从本机文件推出来，不发一个请求。唯一的修复动作会先备份、
        再改本机文件，且确认后才执行。
      </p>

      <section className={styles.summary}>
        {/* 播报区只圈住结论文本：把按钮圈进 aria-live 会让读屏器反复念按钮名 */}
        <div className={styles.live} aria-live="polite">
          {conclusionTone === null ? (
            <span className={styles.conclusionText}>{conclusion}</span>
          ) : (
            <StatusDot tone={LEVEL_TONE[conclusionTone]}>
              <span className={styles.conclusionText}>{conclusion}</span>
            </StatusDot>
          )}

          {total === 0 ? null : (
            <ul className={styles.counters}>
              <li>
                <StatusDot tone={LEVEL_TONE.ok}>通过 {okCount} 项</StatusDot>
              </li>
              <li>
                <StatusDot tone={LEVEL_TONE.info}>警告 {warnCount} 项</StatusDot>
              </li>
              <li>
                <StatusDot tone={LEVEL_TONE.fail}>失败 {failCount} 项</StatusDot>
              </li>
            </ul>
          )}
        </div>

        <Button
          variant="secondary"
          size="sm"
          icon="refresh"
          loading={loading}
          onClick={() => void refresh('doctor')}
        >
          重新体检
        </Button>
      </section>

      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {total === 0 && loading ? (
        <div className={styles.loading}>
          <Spinner label="正在体检本机配置" />
        </div>
      ) : null}

      {/* 空态只在加载过一轮之后出现：loadedKeys.doctor 没立起来之前，首帧不许闪「还没有体检结果」 */}
      {total === 0 && loaded && !loading && reason === null ? (
        <EmptyState
          icon="doctor"
          title="还没有体检结果"
          description="体检是按需运行的本地检查，现在还没有结果：应用启动时的那次体检没跑成，或者这一页从没体检过。"
          action={{ label: '开始体检', icon: 'play', variant: 'primary', onClick: () => void refresh('doctor') }}
          hint={
            <>
              等价的命令行是 <code className={styles.code}>claude1 doctor</code>，两边看到的是同一批检查。
            </>
          }
        />
      ) : null}

      {GROUP_ORDER.map((level) => {
        const items = grouped[level];
        if (items.length === 0) return null;
        return (
          <section className={styles.group} key={level}>
            <SectionHeader
              level={3}
              title={LEVEL_LABEL[level]}
              subtitle={GROUP_CAPTION[level]}
              count={items.length}
            />
            <ul className={styles.list}>
              {items.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  defaultOpen={level !== 'ok'}
                  canFix={check.fixAction === FIX_SUBAGENT_PINS}
                  onFix={(target) => setPending(target)}
                  fixing={fixingId === check.id}
                  fixError={check.fixAction === FIX_SUBAGENT_PINS ? fixReason : null}
                />
              ))}
            </ul>
          </section>
        );
      })}

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="清理子代理模型固定值"
        description="桌面端对 CC Switch 数据库只读，所以这一步交给 CLI 做。"
        closeOnOverlay={false}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              onClick={() => {
                if (pending !== null) void runFix(pending);
              }}
            >
              确认清理
            </Button>
          </>
        }
      >
        <p className={styles.dialogText}>
          会调用 <code className={styles.code}>claude1 doctor --fix</code>
          ：它先备份 CC Switch 数据库，再清掉 settings_config 里的{' '}
          <code className={styles.code}>CLAUDE_CODE_SUBAGENT_MODEL</code> 键。
        </p>
        <p className={styles.dialogText}>
          清完之后子代理会跟随会话主模型，槽位设置对子代理重新生效。桌面端会自动重跑体检，上面的结论换成新结果。
        </p>
      </Dialog>
    </div>
  );
}
