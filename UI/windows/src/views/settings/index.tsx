import { Button, Field, SegmentedControl, Switch } from '../../components';
import { useApp } from '../../store';
import { useNav } from '../../store/nav';
import { useUi } from '../../store/ui';
import { bilingual as b, useLocale } from '../../i18n';
import EnvRow from './parts/EnvRow';
import PathRow from './parts/PathRow';
import styles from './index.module.css';

/** 设置页不做第二层侧栏（避免与主导航叠成双层），全部分区单页堆叠一次给出。 */
export default function SettingsView() {
  const { language, setLanguage } = useLocale();
  const { theme, setTheme, sidebarCollapsed, toggleSidebar } = useNav();
  const { density, setDensity } = useUi();
  const env = useApp((state) => state.env);
  const reason = useApp((state) => state.error.env);
  const loading = useApp((state) => state.loading.env);
  const refresh = useApp((state) => state.refresh);
  const unavailable = <div className={styles.fallback}>
    <p role={reason ? 'alert' : undefined}>{reason ?? (loading ? b('正在读取本机环境…', 'Reading environment…') : b('尚未读取到本机环境。', 'Environment is not available yet.'))}</p>
    <Button size="sm" icon="refresh" onClick={() => void refresh('env')}>{b('重新读取', 'Try again')}</Button>
  </div>;
  return <div className={styles.view}>
    <section className={styles.section} aria-labelledby="settings-appearance">
      <h2 id="settings-appearance">{b('外观', 'Appearance')}</h2>
      <div className={styles.fields}>
        <Field label={b('主题', 'Theme')} hint={b('跟随系统外观，或固定使用深色与浅色。', 'Follow the system appearance or choose a fixed theme.')}>
          <SegmentedControl aria-label={b('主题', 'Theme')} value={theme} onChange={setTheme} options={[{value:'system',label:b('跟随系统','System'),icon:'monitor'},{value:'dark',label:b('深色','Dark'),icon:'moon'},{value:'light',label:b('浅色','Light'),icon:'sun'}]} />
        </Field>
        <Field label={b('显示语言', 'Display language')} hint={b('立即生效并保存在本机。设置、导航和渠道管理支持双语；其他页面及后端错误保留原文。', 'Saved on this device and applied immediately. Settings, navigation and provider management are bilingual; other pages and backend errors keep their original text.')}>
          <SegmentedControl aria-label={b('显示语言', 'Display language')} value={language} onChange={setLanguage} options={[{value:'zh-CN',label:'简体中文'},{value:'en',label:'English'}]} />
        </Field>
        <Field label={b('界面大小', 'Interface size')} hint={b('文字、图标与控件一起缩放。', 'Scale text, icons and controls together.')}>
          <SegmentedControl aria-label={b('界面大小', 'Interface size')} value={density} onChange={setDensity} options={[{value:'standard',label:b('标准','Standard')},{value:'large',label:b('大','Large')},{value:'larger',label:b('特大','Larger')}]} />
        </Field>
        <Field label={b('侧栏', 'Sidebar')}><Switch checked={sidebarCollapsed} onChange={toggleSidebar} label={b('折叠侧栏，只留图标', 'Collapse sidebar to icons')} /></Field>
      </div>
    </section>
    <section className={styles.section} aria-labelledby="settings-paths">
      <h2 id="settings-paths">{b('路径', 'Paths')}</h2>
      {env ? <div className={styles.rows}>
        <PathRow label={b('渠道数据库', 'Provider database')} path={env.dbPath} hint={b('当前读取的渠道库。新增、编辑与导入始终写入 Hub 自有库。', 'The database used for reading providers. Adds, edits and imports always write to the Hub-owned store.')} />
        <PathRow label={b('本地配置', 'Local configuration')} path={env.configPath} hint={b('Claude 渠道的隐藏、别名、模型与 effort 覆盖。', 'Visibility, aliases, model and effort overrides for Claude providers.')} />
        <PathRow label={b('日志目录', 'Log directory')} path={env.logsDir} hint={b('已记录的用量与错误。', 'Recorded usage and errors.')} />
        <PathRow label={b('任务清单', 'Task list')} path={env.configPath.replace(/[^/\\]+$/, 'agent-hub-tasks.json')} hint={b('默认路径；设置 AGENT_HUB_TASKS_PATH 时以该变量为准。', 'Default path; AGENT_HUB_TASKS_PATH takes precedence when set.')} />
      </div> : unavailable}
    </section>
    <section className={styles.section} aria-labelledby="settings-environment">
      <h2 id="settings-environment">{b('本机环境', 'Environment')}</h2>
      {env ? <dl className={styles.rows}>
        <EnvRow label={b('平台','Platform')} value={env.platform?.trim() || null} mono missingImpact={b('无法识别平台。','Platform could not be detected.')} />
        <EnvRow label={b('应用版本','App version')} value={env.appVersion?.trim() || null} mono missingImpact={b('反馈问题时请附安装包名称。','Include the package filename when reporting issues.')} />
        <EnvRow label="Tauri" value={env.tauriVersion?.trim() || null} mono missingImpact={b('无法读取 WebView 框架版本。','WebView framework version is unavailable.')} />
        <EnvRow label="Claude Code" value={env.hasClaudeBin ? b('已检测到','Detected') : null} dot missingImpact={b('未找到可执行文件，Claude 会话无法启动。','Executable not found; Claude sessions cannot start.')} />
        <EnvRow label="Python" value={env.pythonVersion?.trim() || null} mono missingImpact={b('未找到 Python，启动器与修复操作可能无法运行。','Python not found; launchers and repair actions may be unavailable.')} />
      </dl> : unavailable}
    </section>
    <section className={styles.section} aria-labelledby="settings-about">
      <h2 id="settings-about">{b('关于', 'About')}</h2>
      <div className={styles.about}>
        <p className={styles.brand}>Agent Hub</p>
        <p>{b('在本机管理 Claude Code 与 Codex 渠道。会话通过各自的命令行启动器运行。', 'Manage Claude Code and Codex providers locally. Sessions run through their respective command-line launchers.')}</p>
        <p>{b('凭证不会回传到界面。系统凭证迁移需要明确确认；启动仍可能使用受限临时认证文件。', 'Credentials are never returned to the interface. Moving legacy credentials to the system store requires confirmation; launching may still use restricted temporary authentication files.')}</p>
        <p>{b('账号池只读；缺少价格时不估算费用。对话页的回复经本机 hub 发出，历史会话是 ~/.claude/projects 的只读回放。', 'Account pools are read-only. Costs are not estimated without prices. Chat replies go through the local hub; history sessions are read-only replays from ~/.claude/projects.')}</p>
      </div>
    </section>
  </div>;
}
