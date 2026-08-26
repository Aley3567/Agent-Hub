/**
 * 用量视图 → 诊断视图的跳转交接。
 *
 * 用量明细里点某一回合的「降级 N 项」，要落到诊断视图并且**只看这几个码**，
 * 否则跳过来还得自己在几十条里翻，等于没跳。这个 store 只承载一次性的跳转意图：
 * 诊断视图消费完立刻 clear，不做持久状态。
 */
import { create } from 'zustand';

export type DiagnosticsSection = 'degrade' | 'failure';

export interface DiagnosticsFocus {
  section: DiagnosticsSection;
  /** 只看这些降级码；空数组表示不限定 */
  codes: readonly string[];
  /** 触发序号：同样的码再点一次也要能重新聚焦 */
  seq: number;
}

export interface HandoffState {
  focus: DiagnosticsFocus | null;
  /** 请求诊断视图聚焦到某一段，可附带只看哪些降级码 */
  request(section: DiagnosticsSection, codes?: readonly string[]): void;
  /** 意图已被消费 */
  clear(): void;
}

export const useDiagnosticsHandoff = create<HandoffState>()((set, get) => ({
  focus: null,
  request: (section, codes = []) => {
    const seq = (get().focus?.seq ?? 0) + 1;
    set({ focus: { section, codes: [...codes], seq } });
  },
  clear: () => set({ focus: null }),
}));
