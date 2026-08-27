/**
 * 设置视图，回答「外观、路径与本机环境」（CONTRACT.md 6.5 的文案锚点）。
 *
 * 这一页只做三件事：改外观偏好、把本机的几个路径交给系统打开、把检测到的环境照实列出来。
 * 关于区的每一句都对齐 UI/README.md 的安全边界，不在这里发明新的承诺。
 */
import type { ReactNode } from 'react';
import {
  Button,
  Card,
  Field,
  SectionHeader,
  SegmentedControl,
  Spinner,
  Switch,
  type SegmentedOption,
} from '../../components';
import { useApp } from '../../store';
import { THEME_LABEL, useNav, type ThemeMode } from '../../store/nav';
import { DENSITY_LABEL, useUi, type Density } from '../../store/ui';
import EnvRow from './parts/EnvRow';
import PathRow from './parts/PathRow';
import styles from './index.module.css';

const THEME_OPTIONS: ReadonlyArray<SegmentedOption<ThemeMode>> = [
  { value: 'system', label: THEME_LABEL.system, icon: 'monitor', title: '跟随 Windows 的外观设置' },
  { value: 'dark', label: THEME_LABEL.dark, icon: 'moon', title: '始终用深色' },
  { value: 'light', label: THEME_LABEL.light, icon: 'sun', title: '始终用浅色' },
];

const DENSITY_OPTIONS: ReadonlyArray<SegmentedOption<Density>> = [
  { value: 'standard', label: DENSITY_LABEL.standard, title: '默认密度' },
  { value: 'large', label: DENSITY_LABEL.large, title: '整体放大到 112.5%' },
  { value: 'larger', label: DENSITY_LABEL.larger, title: '整体放大到 125%' },
];

/** 空字符串等于没检测到，不让它渲染成一行空白 */
function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 任务清单路径。app_env 的返回集被 CONTRACT.md 第 3 节钉死、没有 tasksPath 字段，
 * 而默认位置就是配置路径旁边那个 agent-hub-tasks.json（Rust 侧 paths.rs 的 tasks_path()），
 * 所以从 configPath 换最后一个路径段派生。设了 AGENT_HUB_TASKS_PATH 环境变量时
 * 真实位置以该变量为准，界面上显示的是默认位置（行的 hint 里写明这一点）。
 */
function tasksPathFrom(configPath: string): string {
  return configPath.replace(/[^/\\]+$/, 'agent-hub-tasks.json');
}

export default function SettingsView() {
  const theme = useNav((state) => state.theme);
  const setTheme = useNav((state) => state.setTheme);
  const sidebarCollapsed = useNav((state) => state.sidebarCollapsed);
  const toggleSidebar = useNav((state) => state.toggleSidebar);
  const density = useUi((state) => state.density);
  const setDensity = useUi((state) => state.setDensity);

  const env = useApp((state) => state.env);
  const envLoading = useApp((state) => state.loading.env === true);
  const envReason = useApp((state) => state.error.env ?? null);
  const refresh = useApp((state) => state.refresh);

  /**
   * env 整体拿不到时的替代内容。
   * 只有路径区放这一份带播报（Spinner 与 role="alert" 都是活区）——同一句话在一屏里出现两个
   * 活区，读屏器会念两遍，所以环境区用下面那份安静的回声。
   */
  const envFallback: ReactNode = envLoading ? (
    <div className={styles.loading}>
      <Spinner label="正在读取本机环境" />
    </div>
  ) : envReason !== null ? (
    <p className={styles.error} role="alert">
      {envReason}
    </p>
  ) : (
    <div className={styles.fallback}>
      <p className={styles.note}>
        未检测到本机环境信息：app_env 还没有返回过结果，所以路径与环境这两段没有可显示的值。
      </p>
      <Button size="sm" icon="refresh" onClick={() => void refresh('env')}>
        重新读取
      </Button>
    </div>
  );

  /** 环境区的安静回声：同样说清为什么空，但不再开一个活区 */
  const envFallbackQuiet: ReactNode = (
    <p className={styles.note}>{envReason ?? '本机环境还没读到；上面的路径区里有原因和重试入口。'}</p>
  );

  return (
    <div className={styles.view}>
      <Card
        header={
          <SectionHeader
            level={3}
            className={styles.sectionHeader}
            title="外观"
            subtitle="主题与侧栏，只影响这台机器上的界面，不写任何配置文件"
          />
        }
      >
        <div className={styles.fields}>
          <Field label="主题" hint="跟随系统时由 Windows 的外观设置决定深浅色。">
            <SegmentedControl
              options={THEME_OPTIONS}
              value={theme}
              onChange={setTheme}
              aria-label="主题"
            />
          </Field>
          <Field label="界面大小" hint="整体缩放界面：图标、文字、控件一起变大，立即生效。">
            <SegmentedControl
              options={DENSITY_OPTIONS}
              value={density}
              onChange={setDensity}
              aria-label="界面大小"
            />
          </Field>
          <Field label="侧栏" hint="折叠后只留图标，Ctrl+B 也能切换。">
            <Switch
              checked={sidebarCollapsed}
              onChange={() => toggleSidebar()}
              label="折叠侧栏，只留图标"
            />
          </Field>
        </div>
      </Card>

      <Card
        header={
          <SectionHeader
            level={3}
            className={styles.sectionHeader}
            title="路径"
            subtitle="桌面端读写的就是这几个位置；只允许打开 ~/.cc-switch 下的路径，越界会被 Rust 侧拒绝，原因显示在对应那一行"
          />
        }
      >
        {env === null ? (
          envFallback
        ) : (
          <div className={styles.rows}>
            <PathRow
              label="数据库路径"
              path={env.dbPath}
              hint="CC Switch 的 SQLite 库。桌面端只以只读模式打开它，不存在写入路径。"
            />
            <PathRow
              label="配置路径"
              path={env.configPath}
              hint="claude1 的本地覆盖：隐藏、别名、模型与 effort 都写在这里。"
            />
            <PathRow
              label="日志目录"
              path={env.logsDir}
              hint="用量与错误 journal 都在这个目录下，用量视图与诊断视图读的就是它们。"
            />
            <PathRow
              label="任务清单路径"
              path={tasksPathFrom(env.configPath)}
              hint="计划任务清单：任务视图的增删改都写在这里。设了 AGENT_HUB_TASKS_PATH 环境变量时真实位置以它为准，这里显示的是默认位置。"
            />
          </div>
        )}
      </Card>

      <Card
        header={
          <SectionHeader
            level={3}
            className={styles.sectionHeader}
            title="本机环境"
            subtitle="全部是真检测出来的；检测不到就说未检测到，并说明影响"
          />
        }
      >
        {env === null ? (
          envFallbackQuiet
        ) : (
          <dl className={styles.rows}>
            <EnvRow
              label="平台"
              value={nonEmpty(env.platform)}
              mono
              missingImpact="读不到平台名，界面仍按 Windows 的规则渲染，可能与实际不符。"
            />
            <EnvRow
              label="应用版本"
              value={nonEmpty(env.appVersion)}
              mono
              missingImpact="读不到版本号，报问题时请附上安装包文件名。"
            />
            <EnvRow
              label="Tauri 版本"
              value={nonEmpty(env.tauriVersion)}
              mono
              missingImpact="读不到 Tauri 版本，排查 WebView 相关问题时会少一条线索。"
            />
            <EnvRow
              label="claude 可执行文件"
              value={env.hasClaudeBin ? '已检测到' : null}
              dot
              missingImpact="没找到 claude 可执行文件：真正跑会话的是它，桌面端只是遥控器，所以启动动作会失败。"
            />
            <EnvRow
              label="Python 版本"
              value={nonEmpty(env.pythonVersion)}
              mono
              missingImpact="没找到 python3：体检里的修复动作要靠它调 claude1，这些动作会失败。"
            />
          </dl>
        )}
      </Card>

      <Card
        header={
          <SectionHeader
            level={3}
            className={styles.sectionHeader}
            title="关于"
            subtitle="这个桌面端在整套东西里的位置"
          />
        }
      >
        <p className={styles.aboutLead}>
          claude1 的核心是 headless 的：真正做协议转换与转发的是 hub 和启动器，桌面端只是它们的遥控器。
        </p>
        <ul className={styles.aboutList}>
          <li className={styles.aboutItem}>不做协议转换、不做转发——它不是第二个网关。</li>
          <li className={styles.aboutItem}>不发任何遥测、不连任何外部域名。</li>
          <li className={styles.aboutItem}>
            CC Switch 数据库只读打开，写操作只落在 claude1-config.json、claude-hub.json 与 agent-hub-tasks.json。
          </li>
          <li className={styles.aboutItem}>
            凭证在 Rust 侧就被剥离，界面上只会看到「已配置 / 未配置」，也不提供复制凭证的入口。
          </li>
          <li className={styles.aboutItem}>
            账号池首版只读；用量只呈现已经记过账的数据，没有价格表就不估算金额。
          </li>
          <li className={styles.aboutItem}>
            对话视图当前是演示实现：会话与回复都来自内置演示数据，不接任何真实后端。
          </li>
          <li className={styles.aboutItem}>没有自动更新、没有托盘常驻、没有 deep link。</li>
        </ul>
      </Card>
    </div>
  );
}
