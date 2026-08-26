/**
 * toast 渲染层（--z-toast）。数据全在 store/toast.ts，这里只负责画出来：
 * 右下角堆叠、成功/失败两种语义色（图标 + 颜色双重编码，DESIGN.md 第 6 节）、可手动关闭。
 *
 * 入场动画用 transition 而不是关键帧：DESIGN.md 第 2.5 节的关键帧白名单只有 9 个，
 * toast 进场属「面板入场」那一档（--dur-normal --ease-out），过渡已够表达。
 * 与命令面板遮罩同一手法：初帧透明，挂载后 rAF 翻一次状态，transition 才会跑。
 * 自动消失（3s）与队列上限都在 store 里，这层无状态计时。
 */
import { useEffect, useState } from 'react';
import { Icon } from '../components';
import { cx } from '../lib';
import { useToast } from '../store/toast';
import type { ToastItem } from '../store/toast';
import styles from './ToastLayer.module.css';

function ToastRow({ toast }: { toast: ToastItem }) {
  const dismiss = useToast((state) => state.dismiss);
  const [inDom, setInDom] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setInDom(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={cx(styles.toast, inDom && styles.toastIn)} role="status">
      <span className={cx(styles.icon, toast.kind === 'success' ? styles.iconSuccess : styles.iconError)}>
        <Icon name={toast.kind === 'success' ? 'success' : 'error'} size={16} />
      </span>
      <span className={styles.text}>{toast.text}</span>
      <button
        type="button"
        className={styles.close}
        aria-label="关闭这条提示"
        onClick={() => dismiss(toast.id)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export default function ToastLayer() {
  const toasts = useToast((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.layer} aria-label="操作反馈">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
