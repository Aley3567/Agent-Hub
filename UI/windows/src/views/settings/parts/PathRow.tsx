/**
 * 一条路径 + 两个动作（打开、在资源管理器中显示）。
 *
 * 这两个动作走 store 的 openPath / revealInFolder（内部直通同名 IPC；Rust 侧只放行
 * ~/.cc-switch/ 下的路径，CONTRACT.md 3 节的白名单）。失败会把中文原因记进
 * error.openPath / error.revealInFolder 并抛回本行，这里原样显示在这一行下面，不吞、不改写。
 *
 * 每行自己管 busy 与错误：一行被拒不该让另外两行也变成错误态，所以状态留在行内，
 * 而不是提到视图根上用 path 当 key 记一张表。
 *
 * 成功反馈走 toast（保存/打开类操作的统一反馈通道，REDESIGN-PROMPT 2.3.5）；
 * 失败不加 error toast——行内 role="alert" 已经原样播报了原因，再推一条 toast
 * 会让读屏器把同一句错误念两遍。
 */
import { useState } from 'react';
import { Button } from '../../../components';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import styles from './PathRow.module.css';

export interface PathRowProps {
  label: string;
  /** 一句话说清这个路径里放的是什么 */
  hint: string;
  /** 绝对路径，由 app_env 给出 */
  path: string;
}

type Busy = 'open' | 'reveal';

export default function PathRow({ label, hint, path }: PathRowProps) {
  const openPath = useApp((state) => state.openPath);
  const revealInFolder = useApp((state) => state.revealInFolder);
  const toastSuccess = useToast((state) => state.success);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  async function run(kind: Busy) {
    setBusy(kind);
    setReason(null);
    try {
      if (kind === 'open') {
        await openPath(path);
        toastSuccess(`${label}：已用系统默认程序打开`);
      } else {
        await revealInFolder(path);
        toastSuccess(`${label}：已在资源管理器中显示`);
      }
    } catch (cause) {
      setReason(errorText(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        <div className={styles.actions}>
          <Button
            size="sm"
            icon="external"
            loading={busy === 'open'}
            disabled={busy !== null}
            onClick={() => void run('open')}
          >
            打开
          </Button>
          <Button
            size="sm"
            icon="reveal"
            loading={busy === 'reveal'}
            disabled={busy !== null}
            onClick={() => void run('reveal')}
          >
            在资源管理器中显示
          </Button>
        </div>
      </div>
      <code className={styles.path}>{path}</code>
      <p className={styles.hint}>{hint}</p>
      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}
    </div>
  );
}
