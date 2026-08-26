/**
 * 本机体检视图，回答「本机配置有没有问题，只读不联网」（CONTRACT.md 6.5 的文案锚点）。
 *
 * 三件事在这一页是硬要求：
 *   1. 总结论区用 aria-live="polite" 播报（DESIGN.md 6 节）；
 *   2. 明确写出「只读本机配置，不连任何上游」——这是 run_doctor 的约束，也是用户的信任前提；
 *   3. 唯一的修复动作（清理子代理模型固定值）必须先确认、说清会备份什么，跑完自动重跑体检。
 *
 * 修复走 doctor_fix_subagent_pins：它自己会重跑一遍体检并把新结果返回。这里用返回值给一句
 * 即时结论，随后仍然调 store 的 refresh('doctor') 把 store 刷成唯一数据源——多跑一次纯本地
 * 检查的代价，换 loading / error 记账不分叉，值得。
 */
import { useMemo, useState } from 'react';
import { doctorFixSubagentPins } from '../../api';
import { Button, Dialog, EmptyState, Icon, SectionHeader, Spinner, StatusDot } from '../../components';
import { errorText, useApp } from '../../store';
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
  const refresh = useApp((state) => state.refresh);

  const [pending, setPending] = useState<DoctorCheck | null>(null);
  const [fixingId, setFixingId] = useState<string | null>(null);
  // 值可能为 undefined：修复成功后要把这一项的旧错误 delete 掉，类型上得允许缺键
  const [fixErrors, setFixErrors] = useState<Record<string, string | undefined>>({});
  const [fixNote, setFixNote] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const out: Record<DoctorLevel, DoctorCheck[]> = { fail: [], info: [], ok: [] };
    for (const check of checks) out[check.level].push(check);
    return out;
  }, [checks]);

  const total = checks.length;
  const failCount = grouped.fail.length;
  const warnCount = grouped.info.length;
  const okCount = grouped.ok.length;

  const conclusion =
    total === 0
      ? '还没有体检结果'
      : failCount === 0 && warnCount === 0
        ? `${total} 项全部通过`
        : `共 ${total} 项，警告 ${warnCount} 项，失败 ${failCount} 项`;
  const conclusionTone: DoctorLevel | null = total === 0 ? null : failCount > 0 ? 'fail' : warnCount > 0 ? 'info' : 'ok';

  async function runFix(target: DoctorCheck) {
    setPending(null);
    setFixingId(target.id);
    setFixNote(null);
    setFixErrors((prev) => {
      const next = { ...prev };
      delete next[target.id];
      return next;
    });
    try {
      const fresh = await doctorFixSubagentPins();
      const after = fresh.find((item) => item.id === target.id) ?? null;
      setFixNote(
        after === null
          ? '清理跑完了：重跑的体检里已经没有这一项。'
          : after.level === 'fail'
            ? `清理跑完了，但「${after.title}」仍然是失败，展开这一项看原因。`
            : `清理跑完了，「${after.title}」现在是${LEVEL_LABEL[after.level]}。`,
      );
    } catch (cause) {
      setFixErrors((prev) => ({ ...prev, [target.id]: errorText(cause) }));
    } finally {
      setFixingId(null);
    }
    await refresh('doctor');
  }

  return (
    <div className={styles.view}>
      <p className={styles.scope}>
        <Icon name="lock" size={13} className={styles.scopeIcon} />
        只读本机配置，不连任何上游：这一页的每条结论都是从本机文件推出来的，不发一个请求。
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

          {fixNote === null ? null : <p className={styles.fixNote}>{fixNote}</p>}
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

      {total === 0 && !loading && reason === null ? (
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
                  fixError={fixErrors[check.id] ?? null}
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
