/**
 * toast store。复制、启动会话、保存设置三类操作的统一反馈通道（REDESIGN-PROMPT 第 2.3 节第 5 条）。
 *
 * 刻意做成最小实现，规则只有四条：
 *   1. 两态：success / error，不做 info、warning——反馈只回答「成了没有」；
 *   2. 3s 自动消失，也可以手动关闭；
 *   3. 队列上限 MAX_TOASTS，超出时丢弃最旧的一条，绝不让 toast 堆成第二屏；
 *   4. 文本入口统一过 redactSecrets（fail-closed 兜底，CONTRACT.md 第 1.2 节）——
 *      反馈文本里混着 IPC 错误原文与命令回显，不赌上游一定干净。
 *
 * 它不进 AppState / NavState——那两个接口由 CONTRACT.md 第 6.2 节钉死；
 * 与 store/ui.ts、shell/announce.ts 同一套路，另开一个极小 store。
 * 渲染层是 shell/ToastLayer.tsx（挂在 App 根部，--z-toast 层级）。
 */
import { create } from 'zustand';
import { redactSecrets } from '../lib';

export type ToastKind = 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  /** 已过 redactSecrets 的展示文本 */
  text: string;
}

export interface ToastState {
  toasts: ToastItem[];
  /** 推入一条 toast，返回其 id（调用方一般不需要，留给测试与精确关闭） */
  push(kind: ToastKind, text: string): number;
  dismiss(id: number): void;
  /** 与 push 等价的语义便捷入口，视图侧按成败二选一 */
  success(text: string): number;
  error(text: string): number;
}

/** 同时可见的 toast 上限：再多就是连环操作的连发反馈，最旧的让位给最新的 */
const MAX_TOASTS = 3;

/** 自动消失时长（ms）。不是动效，不占 DESIGN.md 第 2.5 节的过渡 token */
const AUTO_DISMISS_MS = 3000;

let nextId = 1;

/** id → 自动消失的定时器；手动关闭时要清掉，免得稍后误删新 toast */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export const useToast = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = nextId;
    nextId += 1;
    set((state) => {
      // 队列满时丢弃最旧的，连它的定时器一起清
      const overflow = state.toasts.slice(0, Math.max(0, state.toasts.length + 1 - MAX_TOASTS));
      for (const stale of overflow) clearTimer(stale.id);
      return { toasts: [...state.toasts.slice(overflow.length), { id, kind, text: redactSecrets(text) }] };
    });
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS),
    );
    return id;
  },
  dismiss: (id) => {
    clearTimer(id);
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
  success: (text) => get().push('success', text),
  error: (text) => get().push('error', text),
}));
