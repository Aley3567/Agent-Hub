/**
 * macOS 标题栏。窗口是 titleBarStyle Overlay + transparent，红绿灯浮在 WebView 上，
 * 所以这里只做三件事：占住 38px 高度、整条可拖拽、把标题居中显示。
 * 不自绘窗口按钮——那是 Windows 侧的事（DESIGN.md 第 5 节）。
 * 右侧放太阳/月亮一键切换深浅色：显示的是「点它会变成什么」（深色下显示太阳）。
 * 三态（跟随系统）仍在侧栏底部的 SegmentedControl 里，这里只做最常用的二态快切。
 */
import { useEffect, useState } from 'react';
import { IconButton } from '../components';
import { VIEW_META } from './views';
import { useNav } from '../store/nav';
import type { ThemeMode } from '../store/nav';
import styles from './TitleBar.module.css';

function useSystemDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setIsDark(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  return isDark;
}

/** 当前实际呈现的模式；system 态跟随系统偏好 */
function resolvedMode(theme: ThemeMode, systemIsDark: boolean): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  return systemIsDark ? 'dark' : 'light';
}

export default function TitleBar() {
  const view = useNav((state) => state.view);
  const theme = useNav((state) => state.theme);
  const setTheme = useNav((state) => state.setTheme);

  const systemIsDark = useSystemDarkMode();
  const mode = resolvedMode(theme, systemIsDark);
  const target = mode === 'dark' ? 'light' : 'dark';

  return (
    <header className={styles.bar} data-tauri-drag-region>
      <span className={styles.title} data-tauri-drag-region>
        Agent Hub · {VIEW_META[view].title}
      </span>
      <div className={styles.actions}>
        <IconButton
          icon={mode === 'dark' ? 'sun' : 'moon'}
          aria-label={target === 'light' ? '切换到浅色模式' : '切换到深色模式'}
          tooltip={target === 'light' ? '切换到浅色模式' : '切换到深色模式'}
          tooltipSide="left"
          onClick={() => setTheme(target)}
        />
      </div>
    </header>
  );
}
