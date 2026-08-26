/**
 * Windows 标题栏。窗口是 decorations false，系统不再画标题栏，所以这里必须自绘
 * （DESIGN.md 第 5 节 Windows 列）：高 32px，左侧 12px 放应用名，右侧是最小化 /
 * 最大化 / 关闭三个 46×32 的按钮，close 的 hover 是 Fluent 的红底白图标。
 *
 * 三个实现要点：
 *   1. data-tauri-drag-region 只盖左侧的应用名条。它会吞掉区域内的点击，套到按钮上按钮就废了。
 *   2. 最大化状态要跟着窗口变（双击拖拽区、Win+↑、系统贴靠都会改它），所以订阅 onResized
 *      而不是只在点击时翻转一个本地布尔值——那样迟早和真实窗口状态错位。
 *   3. 没有 Rust 环境时（浏览器里跑 dev:renderer）根本没有窗口可控，按钮置灰并说明原因，
 *      不做成点了没反应的假按钮。
 *
 * 按钮不挂 Tooltip：系统原生的窗口按钮也不带自绘浮层，而标题栏贴着窗口上沿，
 * 浮层只会盖住屏幕边缘。无障碍靠 aria-label 保证。
 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from '../components';
import type { IconName } from '../components';
import { isOffline } from '../api';
import { cx } from '../lib';
import { useNav } from '../store/nav';
import { useAnnouncer } from './announce';
import { VIEW_META } from './views';
import styles from './TitleBar.module.css';

type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

/** 失败播报里用的动作名，和按钮的 aria-label 各管一处，不互相凑用 */
const ACTION_LABEL: Record<WindowAction, string> = {
  minimize: '最小化窗口',
  toggleMaximize: '切换窗口最大化',
  close: '关闭窗口',
};

const OFFLINE_HINT =
  '没有检测到 Rust 侧，这里没有真实窗口可以控制（浏览器里预览前端时就是这种状态）';

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface CaptionButtonProps {
  action: WindowAction;
  icon: IconName;
  label: string;
  danger: boolean;
  disabled: boolean;
  onFailure(message: string): void;
}

function CaptionButton({ action, icon, label, danger, disabled, onFailure }: CaptionButtonProps) {
  const onClick = (): void => {
    const win = getCurrentWindow();
    const task =
      action === 'minimize'
        ? win.minimize()
        : action === 'toggleMaximize'
          ? win.toggleMaximize()
          : win.close();
    void task.catch((error: unknown) => {
      onFailure(`${ACTION_LABEL[action]}失败：${describe(error)}`);
    });
  };

  return (
    <button
      type="button"
      className={cx(styles.caption, danger && styles.captionClose)}
      aria-label={label}
      disabled={disabled}
      title={disabled ? OFFLINE_HINT : undefined}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

export default function TitleBar() {
  const view = useNav((state) => state.view);
  const announce = useAnnouncer((state) => state.announce);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isOffline) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = (): void => {
      void win
        .isMaximized()
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch((error: unknown) => {
          // 读不到最大化状态只影响图标该画哪个，不该把整条标题栏拖down，但也不静默
          if (alive) announce(`读取窗口最大化状态失败：${describe(error)}`);
        });
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      void unlisten.then((off) => off()).catch(() => undefined);
    };
  }, [announce]);

  return (
    <header className={styles.bar}>
      <div className={styles.drag} data-tauri-drag-region>
        <span className={styles.title} data-tauri-drag-region>
          Agent Hub · {VIEW_META[view].title}
        </span>
      </div>

      <div className={styles.captions}>
        <CaptionButton
          action="minimize"
          icon="win-minimize"
          label="最小化"
          danger={false}
          disabled={isOffline}
          onFailure={announce}
        />
        <CaptionButton
          action="toggleMaximize"
          icon={maximized ? 'win-restore' : 'win-maximize'}
          label={maximized ? '向下还原' : '最大化'}
          danger={false}
          disabled={isOffline}
          onFailure={announce}
        />
        <CaptionButton
          action="close"
          icon="win-close"
          label="关闭"
          danger
          disabled={isOffline}
          onFailure={announce}
        />
      </div>
    </header>
  );
}
