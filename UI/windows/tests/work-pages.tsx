import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
const calls: { command: string; args: any }[] = [];
const pending: { filter: string; resolve: (rows: any[]) => void }[] = [];
const fixture = { number: 7, title: 'Synthetic PR', url: 'https://github.com/example/project/pull/7', repository: { nameWithOwner: 'example/project' }, author: { login: 'fixture' }, state: 'open', isDraft: false, updatedAt: '2026-09-16T00:00:00Z' };
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  calls.push({command, args});
  if (command === 'list_pull_requests') return new Promise(resolve => pending.push({filter: args.filter, resolve}));
}};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { default: PullRequests } = await import('../src/views/pull-requests');
const { default: Tasks } = await import('../src/views/tasks');
const { useLocale, readLanguage } = await import('../src/i18n');
const { useApp } = await import('../src/store');
const { viewShortcut } = await import('../src/shell/views');
const original = readLanguage(); useLocale.getState().setLanguage('en');
const root = createRoot(document.getElementById('root')!);
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const click = async (text: string) => { const el = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text); assert(el, `button ${text}`); await act(async () => el!.click()); };
try {
  await act(async () => root.render(<StrictMode><PullRequests /></StrictMode>));
  await click('Review requested');
  await act(async () => { pending.findLast(p => p.filter === 'review')!.resolve([{...fixture, title: 'Review fixture'}]); });
  await act(async () => { pending.filter(p => p.filter === 'all').forEach(p => p.resolve([fixture])); });
  assert(document.body.textContent?.includes('Review fixture') && !document.body.textContent?.includes('Synthetic PR'), 'stale PR requests must not replace active filter');
  await act(async () => (document.querySelector('button[aria-label="Review fixture · example/project #7"]') as HTMLButtonElement).click());
  assert(calls.some(c => c.command === 'open_pull_request' && c.args.url === fixture.url), 'PR opens through guarded command');
  assert(viewShortcut('settings').endsWith('0') && viewShortcut('pullRequests') === '', 'existing settings shortcut must stay stable');
  const base = { kind: 'doctor-reminder' as const, target: null, schedule: '* * * * *', scheduleText: 'every minute', lastRunAt: null, nextRunAt: 2000000000, createdAt: 1 };
  useApp.setState({ tasks: [{...base, id: 'active', name: 'Active fixture', enabled: true}, {...base, id: 'paused', name: 'Paused fixture', enabled: false}, {...base, id: 'done', name: 'Done fixture', enabled: true, lastRunStatus: 'reminded'}], loadedKeys: {tasks: true} });
  await act(async () => root.render(<Tasks />));
  await click('Paused');
  assert(document.querySelectorAll('article').length === 1 && document.querySelector('article')?.getAttribute('aria-label') === 'Paused fixture', 'paused filter');
  await click('Recent successes');
  assert(document.querySelectorAll('article').length === 1 && document.body.textContent?.includes('Reminder triggered'), 'triggered filter uses real result, not enabled state');
  document.getElementById('result')!.textContent = 'PASS: PR StrictMode/stale responses/opening, stable shortcuts, task status filters';
} catch (error) { document.getElementById('result')!.textContent = `FAIL: ${error}`; }
finally { await act(async () => root.unmount()); useLocale.getState().setLanguage(original); }
