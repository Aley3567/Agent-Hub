import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { t, useLocale, readLanguage } from '../src/i18n';
import '../src/styles/tokens.css';
import '../src/styles/global.css';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const original = readLanguage();
useLocale.getState().setLanguage('zh-CN');
// Import while Chinese is active to catch translations frozen at module load.
const { default: UsageView } = await import('../src/views/usage');
const { default: Sidebar } = await import('../src/shell/Sidebar');
const { default: DoctorView } = await import('../src/views/doctor');
const { useApp } = await import('../src/store');
const { useNav } = await import('../src/store/nav');
const { mockUsageSummary, MOCK_DOCTOR } = await import('../src/api/mock');
const { formatTokensCn } = await import('../src/lib/format');
const assert = (ok: unknown, reason: string) => { if (!ok) throw new Error(reason); };
const root = createRoot(document.getElementById('root')!);
const now = Date.now() / 1000;
useApp.setState({ usage: mockUsageSummary(now - 7 * 86400, now, 'day'), recentUsage: [], doctor: MOCK_DOCTOR, loadedKeys: { usage: true, doctor: true }, loading: {}, refresh: async () => undefined });
useNav.setState({ sidebarCollapsed: false });
try {
  await act(async () => {
    useLocale.getState().setLanguage('en');
    root.render(<><Sidebar /><section id="usage"><UsageView /></section></>);
  });
  const usage = document.getElementById('usage')!.textContent!;
  assert(!/\p{Script=Han}/u.test(usage), 'Usage interface must be completely English');
  for (const label of ['Cache reads', 'Uncached input', 'Usage trend', '24 hours', 'By token type']) assert(usage.includes(label), `Missing English label: ${label}`);
  const theme = document.querySelector('nav [role="radiogroup"]')!.getBoundingClientRect();
  const toggle = document.querySelector('button[aria-label="Collapse sidebar"]')!.getBoundingClientRect();
  assert(Math.abs(theme.y - toggle.y) < 1 && theme.right <= toggle.left, 'Theme and sidebar toggle must share one row without overlap');
  assert(formatTokensCn(100000000) === '100.0M', 'English must not use Chinese numeric units');
  assert(t('路径不存在：/tmp/用户文件') === 'Path does not exist: /tmp/用户文件', 'Built-in errors translate without changing user paths');
  assert(t('上游自定义原文') === '上游自定义原文', 'Unknown upstream text must stay intact');
  await act(async () => root.render(<DoctorView />));
  assert(document.body.textContent?.includes('Some channels pin the subagent model'), 'Built-in diagnostic titles must translate');
  await act(async () => { useLocale.getState().setLanguage('zh-CN'); root.render(<UsageView />); });
  assert(document.body.textContent?.includes('缓存读取'), 'Switching back must restore Chinese');
  assert(formatTokensCn(100000000).includes('亿'), 'Chinese number formatting must be restored');
  document.getElementById('result')!.textContent = 'PASS: full English usage, runtime language switching, compact theme row, built-in diagnostics, preserved user content';
} catch (error) {
  document.getElementById('result')!.textContent = `FAIL: ${error}`;
} finally {
  await act(async () => { root.unmount(); useLocale.getState().setLanguage(original); });
}
