import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const calls: {command: string; args: any}[] = [];
let rejectApply = false;
let holdApply: (() => void) | undefined;
const candidate = { candidateId: '0', id: 'same', appType: 'claude', name: 'Fixture', endpoint: 'https://example.test', protocol: 'anthropic', credential: 'available', conflict: false, blockedReason: null };
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  calls.push({ command, args });
  if (command === 'preview_import') return { planId: 'fixture-plan', source: 'cc-switch', candidates: [candidate], blocked: [] };
  if (command === 'select_import') return { added: 1, updated: 0, skipped: 0, selected: args.selected, replace: args.replace };
  if (command === 'apply_import') {
    if (rejectApply) throw new Error('credential_denied');
    await new Promise<void>((resolve) => { holdApply = resolve; });
    return { added: 1, updated: 0, skipped: 0, pendingCleanup: 0 };
  }
  return undefined;
}};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { default: ManagementDialog } = await import('../src/views/channels/parts/ManagementDialog');
const { channelWindow } = await import('../src/views/channels/model');
const { MOCK_CHANNELS } = await import('../src/api/mock');
const { useApp } = await import('../src/store');
const refreshed: string[] = [];
useApp.setState({ refresh: async (key) => { refreshed.push(key); } });
let root = createRoot(document.getElementById('root')!);
let closed = 0;
let completed = '';
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert(button, `missing button ${text}`);
  await act(async () => { button!.click(); });
};
async function mount() {
  await act(async () => root.render(<StrictMode><ManagementDialog mode="import" onClose={() => { closed++; }} onComplete={(message) => { completed = message; }} /></StrictMode>));
}
try {
  await mount();
  await click('扫描并预览');
  assert(document.body.textContent?.includes('Fixture'), 'StrictMode scan must retain preview');
  assert(!calls.some((c) => c.command === 'cancel_import'), 'StrictMode must not cancel a live preview');
  await click('取消');
  await act(async () => root.unmount());
  assert(calls.some((c) => c.command === 'cancel_import'), 'unmount cancels preview');
  assert(!calls.some((c) => c.command === 'apply_import'), 'cancel must never write');
  root = createRoot(document.getElementById('root')!);
  await mount(); await click('扫描并预览');
  rejectApply = true;
  await click('确认导入');
  assert(document.querySelector('[role="alert"]')?.textContent === 'credential_denied', 'failure remains in dialog');
  assert(closed === 1, 'failure must not close');
  rejectApply = false;
  await click('扫描并预览');
  const before = calls.filter((c) => c.command === 'apply_import').length;
  const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '确认导入')!;
  await act(async () => { confirm.click(); confirm.click(); });
  assert(calls.filter((c) => c.command === 'apply_import').length === before + 1, 'duplicate click must write once');
  await act(async () => holdApply!());
  assert(closed === 2 && completed.includes('新增 1'), 'successful write closes with counts');
  assert(refreshed.join(',') === 'channels,hubs,pools', 'successful write refreshes dependent views');
  const base = { ...MOCK_CHANNELS[0], id: 'same', name: 'Fixture' };
  const now = 100000;
  const rows: any[] = [
    { ts: now, channel: 'Fixture', providerApp: 'claude', providerId: 'same', in: 10 },
    { ts: now, channel: 'Fixture', providerApp: 'codex', providerId: 'same', in: 20 },
    { ts: now, channel: 'Fixture', harness: 'codex', in: 30 },
    { ts: now, channel: 'Fixture', in: 40 },
  ];
  assert(channelWindow(rows, {...base, appType: 'claude'}, now).inTokens === 50, 'Claude window must exclude Codex identity and unknown Codex history');
  assert(channelWindow(rows, {...base, appType: 'codex'}, now).inTokens === 20, 'Codex history needs explicit provider identity');
  document.getElementById('result')!.textContent = 'PASS: StrictMode, cancel, failure, duplicate click, refresh, application history';
} catch (error) {
  document.getElementById('result')!.textContent = `FAIL: ${error}`;
} finally { await act(async () => root.unmount()); }
