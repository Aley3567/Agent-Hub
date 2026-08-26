/**
 * 外壳播报区。启动结果与体检结论要用 aria-live="polite" 播报（DESIGN.md 第 6 节），
 * 而这两件事的触发点（命令面板、体检数据到位）与显示点（StatusBar）不在同一棵子树里，
 * 所以用一个极小的 store 把它们连起来。
 *
 * 它不进 AppState / NavState——那两个接口由 CONTRACT.md 第 6.2 节钉死，不能为了播报加字段。
 *
 * 播报文本里混着上游与 Rust 侧的自由文本（LaunchResult.message、IPC 错误原文），
 * 所以入口处统一过一遍前端兜底脱敏：凭证零泄漏是 fail-closed 边界，不赌上游一定干净
 * （CONTRACT.md 第 1.2 节）。
 */
import { create } from 'zustand';
import { redactSecrets } from '../lib';

export interface AnnouncerState {
  /** 最近一条播报文本，空字符串表示没有要播报的内容 */
  message: string;
  announce(text: string): void;
}

export const useAnnouncer = create<AnnouncerState>()((set) => ({
  message: '',
  announce: (text) => set({ message: redactSecrets(text) }),
}));
