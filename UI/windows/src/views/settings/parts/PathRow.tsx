/**
 * 一条路径 + 两个动作（打开、在 Finder 中显示）。
 *
 * 这两个动作走 open_path / reveal_in_folder，Rust 侧只放行 ~/.cc-switch/ 下的路径
 * （CONTRACT.md 3 节的白名单）。被拒绝时把中文原因原样显示在这一行下面，不吞、不改写。
 *
 * 每行自己管 busy 与错误：一行被拒不该让另外两行也变成错误态，所以状态留在行内，
 * 而不是提到视图根上用 path 当 key 记一张表。
 */
import { useState } from 'react';
import { openPath, revealInFolder } from '../../../api';
import { Button } from '../../../components';
import { errorText } from '../../../store';
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
  const [busy, setBusy] = useState<Busy | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  async function run(kind: Busy) {
    setBusy(kind);
    setReason(null);
    try {
      if (kind === 'open') {
        await openPath(path);
      } else {
        await revealInFolder(path);
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
            在 Finder 中显示
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
