/**
 * 对话事件通道：把 Rust 侧的流式增量、终态与失败接进 store。
 *
 * 结构与 shell/taskEvents.ts 逐条对齐——那个文件已经被验证过能正确处理隐藏窗口漏事件、
 * StrictMode 双挂载与卸载竞态：
 *   · 离线早退：没有 Rust 就没有事件，不挂空监听；
 *   · `active` 卸载守卫：每个回调先看它，卸载后到位的事件不写状态；
 *   · 订阅 Promise 统一收进 subscriptions，失败转 toast；清理时反向退订。
 *
 * 终态纪律（AGENTS.md：失败绝不伪装成成功）：
 *   · `truncated` 不算完成——Rust 已把收到的部分正文与一条 system 说明落盘，刷新后会作为
 *     真实消息出现，播报也必须如实说「截断」，不能报「回复完成」；
 *   · 失败只走 toast，绝不往消息流里塞一条 assistant 气泡冒充回复。
 *
 * 兜底对账取 5 秒（taskEvents 是 15 秒）：流式期间界面每几百毫秒就在变，漏一个增量事件
 * 拖到 15 秒后才发现，用户看到的是「回复卡住了」。没有在途流时这个定时器不做事。
 */
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isOffline } from '../api';
import { t } from '../i18n';
import { useApp } from '../store';
import { useToast } from '../store/toast';
import type { ChatStreamChunk, ChatStreamEnd, ChatStreamError } from '../types/contract';
import { useAnnouncer } from './announce';

/** 在途流与真值的对账周期（ms） */
const RECONCILE_TICK_MS = 5_000;

export function useChatEvents(): void {
  useEffect(() => {
    if (isOffline) return;
    let active = true;

    const chunk = listen<ChatStreamChunk>('chat-stream', event => {
      if (!active) return;
      useApp.getState().appendChatDelta(event.payload);
    });

    const end = listen<ChatStreamEnd>('chat-stream-end', event => {
      if (!active) return;
      const { reason } = event.payload;
      useApp.getState().endChatStream(event.payload);
      void useApp.getState().refresh('chat');
      useAnnouncer.getState().announce(
        reason === 'truncated' ? t('回复被上游截断，已保存收到的部分') : t('助手回复完成'),
      );
    });

    const failed = listen<ChatStreamError>('chat-stream-error', event => {
      if (!active) return;
      const state = useApp.getState();
      // 归因守卫在 store 里：事件带 sessionId / requestId，对不上当前在途流的一律作废并
      // 返回 false——缓冲已经没收着（这次尝试已由别的路径交代过，命令回执那侧报过同一条
      // 原文），或者是上一轮流的迟到错误。两种都不该再弹一条同样的 toast：事件通道与命令
      // 回执是两条通道，先后顺序不保证，这里按「谁先到谁报」收口。
      // 返回 true 才继续：先同步收掉缓冲并记终态，再对账、再报原文——顺序反过来的话，
      // reject 那侧看到没有终态记录会再报一遍同一个原因。
      if (!state.failChatStream(event.payload)) return;
      void state.refresh('chat');
      useToast.getState().error(event.payload.message);
    });

    // 隐藏 / 最小化的窗口可能漏事件：流式期间按 5 秒跟真值对账
    const timer = setInterval(() => {
      if (useApp.getState().chatStream === null) return;
      void useApp.getState().refresh('chat');
    }, RECONCILE_TICK_MS);

    const subscriptions = [chunk, end, failed];
    for (const pending of subscriptions) void pending.catch(cause => { if (active) useToast.getState().error(String(cause)); });
    return () => { active = false; clearInterval(timer); for (const pending of subscriptions) void pending.then(off => off()).catch(() => undefined); };
  }, []);
}
