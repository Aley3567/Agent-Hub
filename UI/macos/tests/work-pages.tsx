import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const calls: { command: string; args: any }[] = [];
const pending: { filter: string; resolve: (rows: any[]) => void }[] = [];
const fixture = { number: 7, title: 'Synthetic PR', url: 'https://github.com/example/project/pull/7', repository: { nameWithOwner: 'example/project' }, author: { login: 'fixture' }, state: 'open', isDraft: false, updatedAt: '2026-09-16T00:00:00Z' };

/* 事件通道打桩：Tauri v2 的 listen() 走 invoke('plugin:event|listen', { event, target, handler })，
   handler 是 transformCallback 换来的数字 id（见 @tauri-apps/api/event.js 的 listen 与 core.js 的
   transformCallback）。记住 id → 回调，页面里就能手动推事件，不需要真的跑 Rust 侧。 */
const callbacks = new Map<number, (event: any) => void>();
const listeners: { event: string; id: number }[] = [];
let nextCallbackId = 1;
let sendHold: { resolve: (value: any) => void; reject: (cause: unknown) => void } | null = null;

const nowSec = 1_760_000_000;
const historySession = { id: 'sess-history', title: 'History fixture', channelId: null, model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '历史里的一句话', ts: nowSec - 600 }], createdAt: nowSec - 900, updatedAt: nowSec - 600, source: 'history', hubName: null, projectKey: 'proj-one' };
const localSession = { id: 'sess-local', title: 'Local fixture', channelId: null, model: 'claude-sonnet-4-5', messages: [], createdAt: nowSec - 300, updatedAt: nowSec - 100, source: 'local', hubName: null, projectKey: null };
const projectRows = [
  { key: 'proj-one', path: '/Users/fixture/one', sessionCount: 3, updatedAt: nowSec },
  { key: 'proj-two', path: '/Users/fixture/two', sessionCount: 1, updatedAt: nowSec - 100 },
];

(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: any) => void) => { const id = nextCallbackId; nextCallbackId += 1; callbacks.set(id, callback); return id; },
  invoke: async (command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'plugin:event|listen') { const id = nextCallbackId; nextCallbackId += 1; listeners.push({ event: args.event, id: args.handler }); return id; }
    if (command === 'plugin:event|unlisten') { const at = listeners.findIndex((row) => row.event === args.event); if (at >= 0) listeners.splice(at, 1); return undefined; }
    if (command === 'list_pull_requests') return new Promise((resolve) => pending.push({ filter: args.filter, resolve }));
    if (command === 'list_chat_sessions') return [historySession, localSession];
    if (command === 'chat_projects') return projectRows;
    // 发送命令由用例自己握住：真流式靠手动推事件推进，不靠定时器
    if (command === 'send_chat_message') return new Promise((resolve, reject) => { sendHold = { resolve, reject }; });
    return undefined;
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { default: PullRequests } = await import('../src/views/pull-requests');
const { default: Tasks } = await import('../src/views/tasks');
const { default: TaskDialog } = await import('../src/views/tasks/parts/TaskDialog');
const { detectDraft, toCron } = await import('../src/views/tasks/parts/schedule');
const { default: ChatView } = await import('../src/views/chat');
const { default: ToastLayer } = await import('../src/shell/ToastLayer');
const { useChatEvents } = await import('../src/shell/chatEvents');
const { useToast } = await import('../src/store/toast');
const { useLocale, readLanguage, t, bilingual: b } = await import('../src/i18n');
const { useApp } = await import('../src/store');
const { viewShortcut } = await import('../src/shell/views');
const original = readLanguage(); useLocale.getState().setLanguage('en');
let root = createRoot(document.getElementById('root')!);
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const click = async (text: string) => { const el = [...document.querySelectorAll('button')].find(b2 => b2.textContent?.trim() === text); assert(el, `button ${text}`); await act(async () => el!.click()); };
const remount = async () => { await act(async () => root.unmount()); root = createRoot(document.getElementById('root')!); };
/** 推一条后端事件。事件名必须在 useChatEvents 挂上监听之后再推。 */
const push = (event: string, payload: unknown) => {
  const row = listeners.find((item) => item.event === event);
  assert(row, `没有 ${event} 的监听（事件通道没挂上？）`);
  callbacks.get(row!.id)!({ event, id: 0, payload });
};
/** React 只认原生 setter 打过再冒泡的 input，直接改 .value 不触发 onChange */
const type = async (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const clickByText = async (selector: string, text: string) => {
  const el = [...document.querySelectorAll(selector)].find((node) => node.textContent?.includes(text));
  assert(el, `${selector} 里找不到 ${text}`);
  await act(async () => (el as HTMLElement).click());
};
const lastCall = (command: string) => [...calls].reverse().find((call) => call.command === command);

try {
  await act(async () => root.render(<StrictMode><PullRequests /></StrictMode>));
  await click('Review requested');
  await act(async () => { [...pending].reverse().find(p => p.filter === 'review')!.resolve([{...fixture, title: 'Review fixture'}]); });
  await act(async () => { pending.filter(p => p.filter === 'all').forEach(p => p.resolve([fixture])); });
  assert(document.body.textContent?.includes('Review fixture') && !document.body.textContent?.includes('Synthetic PR'), 'stale PR requests must not replace active filter');
  await act(async () => (document.querySelector('button[aria-label="Review fixture · example/project #7"]') as HTMLButtonElement).click());
  assert(calls.some(c => c.command === 'open_pull_request' && c.args.url === fixture.url), 'PR opens through guarded command');
  assert(viewShortcut('settings').endsWith('0') && viewShortcut('pullRequests') === '', 'existing settings shortcut must stay stable');
  const base = { kind: 'doctor-reminder' as const, target: null, schedule: '* * * * *', scheduleSpec: { kind: 'everyMinutes' as const, period: 1 }, notes: [], lastRunAt: null, nextRunAt: 2000000000, createdAt: 1 };
  useApp.setState({ tasks: [{...base, id: 'active', name: 'Active fixture', enabled: true}, {...base, id: 'paused', name: 'Paused fixture', enabled: false}, {...base, id: 'done', name: 'Done fixture', enabled: true, lastRunStatus: 'reminded'}], loadedKeys: {tasks: true} });
  await act(async () => root.render(<Tasks />));
  await click('Paused');
  assert(document.querySelectorAll('article').length === 1 && document.querySelector('article')?.getAttribute('aria-label') === 'Paused fixture', 'paused filter');
  await click('Recent successes');
  assert(document.querySelectorAll('article').length === 1 && document.body.textContent?.includes('Reminder triggered'), 'triggered filter uses real result, not enabled state');

  /* ---- A. 重复频率选择器：认不出的原串一律原样回显，不静默改写 ---- */
  const scheduleCases: ReadonlyArray<{ raw: string; tier: string; roundtrip: string }> = [
    // 点名回归：曾经的 bug 是把 `0 * * * 1-5` 读成 hourly，用户只调一下分钟就把「工作日」
    // 静默改成了「每天」。周字段受限而「时」为全量的表达式选择器表达不了，必须落 custom。
    { raw: '0 9 * * 1-5', tier: 'weekly', roundtrip: '0 9 * * 1-5' },
    { raw: '0 9 * * 1,3,5', tier: 'weekly', roundtrip: '0 9 * * 1,3,5' },
    { raw: '0 * * * 1-5', tier: 'custom', roundtrip: '0 * * * 1-5' },
    { raw: '0 9 1 * 1,3,5', tier: 'custom', roundtrip: '0 9 1 * 1,3,5' },
    { raw: '*/30 * * * *', tier: 'custom', roundtrip: '*/30 * * * *' },
    { raw: '30 8 * * *', tier: 'daily', roundtrip: '30 8 * * *' },
    { raw: '0 * * * *', tier: 'hourly', roundtrip: '0 * * * *' },
    // 7 折成周日 0：唯一一处刻意归一化的往返
    { raw: '0 9 * * 7', tier: 'weekly', roundtrip: '0 9 * * 0' },
  ];
  for (const item of scheduleCases) {
    const draft = detectDraft(item.raw);
    assert(draft.tier === item.tier, `${item.raw} 应当落在 ${item.tier} 档，实际 ${draft.tier}`);
    const round = toCron(draft);
    assert(round === item.roundtrip, `${item.raw} 往返成了 ${round}，应当是 ${item.roundtrip}`);
  }

  /* A.2 打开编辑对话框：`0 9 * * 1,3,5` 应当落在「每周」档，一 / 三 / 五呈按下态 */
  let editing: any = { id: 'task-edit', name: 'Fixture task', kind: 'doctor-reminder', target: null, schedule: '0 9 * * 1,3,5', scheduleSpec: { kind: 'weekly', minute: 0, hour: 9, days: [1, 3, 5] }, notes: [], enabled: true, lastRunAt: null, lastRunStatus: null, nextRunAt: 2000000000, createdAt: 1 };
  await act(async () => root.render(<StrictMode><TaskDialog open task={editing} onClose={() => undefined} /></StrictMode>));
  const tierGroup = document.querySelector(`[role="radiogroup"][aria-label="${t('重复频率')}"]`);
  assert(tierGroup, '频率档位控件应当出现');
  const activeTier = [...tierGroup!.querySelectorAll('[role="radio"]')].find((node) => node.getAttribute('aria-checked') === 'true');
  assert(activeTier?.textContent?.trim() === t('每周'), `0 9 * * 1,3,5 应落在「每周」档，实际 ${activeTier?.textContent?.trim()}`);
  const weekdayGroup = document.querySelector(`[role="group"][aria-label="${b('星期', 'Weekdays')}"]`);
  assert(weekdayGroup, '「每周」档应当带出星期选择');
  const pressed = (name: string) => weekdayGroup!.querySelector(`button[aria-label="${name}"]`)?.getAttribute('aria-pressed');
  for (const [name, want] of [[b('周一', 'Monday'), 'true'], [b('周三', 'Wednesday'), 'true'], [b('周五', 'Friday'), 'true'], [b('周二', 'Tuesday'), 'false'], [b('周四', 'Thursday'), 'false'], [b('周六', 'Saturday'), 'false'], [b('周日', 'Sunday'), 'false']] as const) {
    assert(pressed(name) === want, `${name} 的按下态应当是 ${want}，实际 ${pressed(name)}`);
  }

  /* A.3 不静默改写的可执行证据：编辑 `0 9 * * 1-5`，什么都不动直接提交，原串必须逐字节带出去 */
  await remount();
  editing = { ...editing, id: 'task-stable', schedule: '0 9 * * 1-5' };
  await act(async () => root.render(<StrictMode><TaskDialog open task={editing} onClose={() => undefined} /></StrictMode>));
  const submitted = calls.length;
  await click(t('保存修改'));
  const update = lastCall('update_task');
  assert(calls.length > submitted && update !== undefined, '提交应当走 update_task');
  assert(update!.args.patch.schedule === '0 9 * * 1-5', `没碰过选择器就必须原样提交 0 9 * * 1-5，实际 ${update!.args.patch.schedule}`);
  assert(update!.args.id === 'task-stable', 'patch 要打在编辑的那个任务上');

  /* ---- B. 对话事件通道：真流式、归因守卫、失败只走 toast ---- */
  await remount();
  useToast.setState({ toasts: [] });
  function ChatHarness() { useChatEvents(); return <><ChatView /><ToastLayer /></>; }
  await act(async () => { await useApp.getState().refresh('chat'); await useApp.getState().refresh('chatProjects'); });
  await act(async () => root.render(<StrictMode><ChatHarness /></StrictMode>));
  const asked = (command: string) => calls.some((call) => call.command === command);
  assert(asked('list_chat_sessions') && asked('chat_projects'), '会话与历史项目应当真走 IPC 读回来');

  /* B.1 历史会话只读，本地会话可发 */
  const input = () => document.querySelector(`textarea[aria-label="${t('消息输入框')}"]`) as HTMLTextAreaElement;
  assert(input() !== null, 'composer 应当渲染出来');
  assert(input().disabled === false, '自动选中的本地会话 composer 应当可用');
  await clickByText('ul button', 'History fixture');
  assert(input().disabled === true, '历史会话只读：composer 必须禁用');
  await clickByText('ul button', 'Local fixture');
  assert(input().disabled === false, '切回本地会话应当恢复可发送');

  /* B.2 真流式：三条同 requestId 的增量逐条上屏，不靠定时器 */
  const streamBox = () => document.querySelector(`[aria-label="${t('消息流')}"]`);
  const streamed = () => streamBox()?.textContent ?? '';
  const streamRows = () => document.querySelectorAll(`[aria-label="${t('消息流')}"] > div`).length;
  const requestId = 'req-fixture';
  await type(input(), 'fixture 提问');
  await click(t('发送'));
  const sent = lastCall('send_chat_message');
  assert(sent?.args.sessionId === 'sess-local' && sent?.args.content === 'fixture 提问', '发送应当打到选中的本地会话');
  assert(streamed().includes('fixture 提问'), '用户消息应当本地回显');
  await act(async () => { push('chat-stream', { sessionId: 'sess-local', requestId, delta: '第一段。' }); });
  assert(streamed().includes('第一段。'), '首个增量应当立刻上屏');
  assert(!streamed().includes('第二段。'), '增量必须逐条到达，不许一次性补全');
  await act(async () => { push('chat-stream', { sessionId: 'sess-local', requestId, delta: '第二段。' }); });
  assert(streamed().includes('第一段。第二段。'), '第二段应当接在第一段后面');
  assert(!streamed().includes('第三段。'), '第三段还没推送，不该出现');
  await act(async () => { push('chat-stream', { sessionId: 'sess-local', requestId, delta: '第三段。' }); });
  assert(streamed().includes('第一段。第二段。第三段。'), '三段正文应当全部到位');

  /* B.3 竞态守卫：requestId 对不上在途流的增量必须丢掉 */
  const beforeStale = streamed();
  await act(async () => { push('chat-stream', { sessionId: 'sess-local', requestId: 'req-retired', delta: '不该出现的旧流增量' }); });
  assert(streamed() === beforeStale, '作废流的迟到增量不许写状态');

  /* B.4 失败：收掉缓冲、只走 toast，绝不往消息流里塞一条 assistant 气泡 */
  const rowsBeforeError = streamRows();
  await act(async () => { push('chat-stream-error', { sessionId: 'sess-local', requestId, message: '上游 500：渠道暂时不可用' }); });
  assert(!streamed().includes('第三段。'), '失败绝不能把在途正文留成一条 assistant 回复');
  assert(!streamed().includes('渠道暂时不可用'), '错误原文只走 toast，不许进消息流');
  assert(streamRows() === rowsBeforeError - 1, `在途正文行应当被收掉：${rowsBeforeError} → ${streamRows()}`);
  const errors = () => useToast.getState().toasts.filter((item) => item.kind === 'error');
  assert(errors().length === 1, `失败应当只报一条 toast，实际 ${errors().length}`);
  assert(errors()[0].text.includes('上游 500'), 'toast 应当是错误原文');
  assert(document.body.textContent?.includes('上游 500'), 'toast 要真的渲染出来，不能只躺在 store 里');
  // 命令回执随后到：同一次失败已经由事件通道交代过，不许再报第二条
  await act(async () => { sendHold!.reject(new Error('上游 500：渠道暂时不可用')); });
  assert(errors().length === 1, `命令回执不该重复报同一条错误，实际 ${errors().length}`);
  assert(!streamed().includes('第三段。'), '命令回执也不许把在途正文变成回复');

  /* B.6 历史项目下拉 */
  const picker = document.querySelector(`select[aria-label="${t('回放哪个项目的历史')}"]`) as HTMLSelectElement;
  assert(picker !== null, '项目选择器应当出现');
  assert(picker.disabled === false, '有历史项目时选择器不该禁用');
  const options = [...picker.options].filter((option) => option.value !== '');
  assert(options.length === 2, `chat_projects 两项都该进下拉，实际 ${options.length}`);
  assert(options.map((option) => option.textContent).join('|') === '/Users/fixture/one|/Users/fixture/two', '下拉 label 应当是真实项目路径');

  /* B.5 渲染结果里不该再有任何「演示」字样 */
  assert(!(document.body.textContent ?? '').includes('演示'), '对话视图不该出现演示数据字样');

  document.getElementById('result')!.textContent = 'PASS: PR StrictMode/stale responses/opening, stable shortcuts, task status filters, schedule tiers/roundtrips/untouched submit, chat attribution/real streaming/toast';
} catch (error) { document.getElementById('result')!.textContent = `FAIL: ${error}\n${(error as Error)?.stack ?? ''}`; }
finally { await act(async () => root.unmount()); useLocale.getState().setLanguage(original); }
