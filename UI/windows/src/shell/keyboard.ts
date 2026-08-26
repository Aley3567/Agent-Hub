/**
 * 全局快捷键。Windows 用 event.ctrlKey 检测（DESIGN.md 第 5 节修饰键行）。
 *
 *   Ctrl+K       打开 / 关闭命令面板
 *   Ctrl+,       打开设置
 *   Ctrl+R       刷新当前视图的数据（必须 preventDefault，否则 WebView 会整页重载）
 *   Ctrl+B       折叠 / 展开侧栏
 *   Ctrl+1..Ctrl+9、Ctrl+0  直达十个视图（顺序同侧栏，第十个落在 Ctrl+0 上）
 *
 * 监听挂在 window 上，卸载时移除。回调内部一律走 getState()，不吃闭包里的旧值。
 */
import { useEffect } from 'react';
import { useNav } from '../store/nav';
import { VIEW_ORDER, refreshView } from './views';

export function useGlobalKeyboard(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 只认 Ctrl，且不与 Alt / Win 键组合，避免抢走系统与终端的组合键。
      // 排除 altKey 还顺手挡住了 AltGr：Windows 上 AltGr 会同时置起 ctrlKey 与 altKey，
      // 欧洲键盘靠它打第三级字符，不能被当成 Ctrl 快捷键吃掉。
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const nav = useNav.getState();
      const key = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        nav.setPaletteOpen(!nav.paletteOpen);
        return;
      }
      if (key === ',') {
        event.preventDefault();
        nav.setPaletteOpen(false);
        nav.setView('settings');
        return;
      }
      if (key === 'r') {
        event.preventDefault();
        void refreshView(nav.view);
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        nav.toggleSidebar();
        return;
      }
      if (key >= '1' && key <= '9') {
        const target = VIEW_ORDER[Number(key) - 1];
        event.preventDefault();
        nav.setPaletteOpen(false);
        nav.setView(target);
        return;
      }
      // 第十个视图没有数字键可用了，落在 Ctrl+0 上（与 viewShortcut 的展示口径一致）
      if (key === '0') {
        const target = VIEW_ORDER[9];
        event.preventDefault();
        nav.setPaletteOpen(false);
        nav.setView(target);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
