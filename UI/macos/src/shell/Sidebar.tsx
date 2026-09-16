/**
 * 主导航侧栏。展开 --sidebar-w(232px)，折叠 --sidebar-w-collapsed(56px) 只留图标（DESIGN.md 第 3 节）。
 * 分组：工作（Pull Request）、会话（对话、渠道、槽位）、观测（用量、诊断、账号池、体检）、扩展（插件、任务）；
 * 主题三态切换贴在品牌区正下方（第一个导航条目之上），底部固定「设置」入口，侧栏折叠与主题同排。
 * 折叠态每一项都靠 Tooltip 说明自己是谁，否则只剩一排看不懂的图标。
 */
import { t } from '../i18n';
import { BrandMark, Icon, IconButton, SegmentedControl, Tooltip } from '../components';
import { cx } from '../lib';
import { THEME_LABEL, nextTheme, useNav } from '../store/nav';
import type { ThemeMode } from '../store/nav';
import { GROUP_LABEL, SIDEBAR_GROUPS, VIEW_LIST, VIEW_META, viewShortcut } from './views';
import type { ViewMeta } from './views';
import styles from './Sidebar.module.css';

const THEME_ICON: Record<ThemeMode, 'monitor' | 'moon' | 'sun'> = {
  system: 'monitor',
  dark: 'moon',
  light: 'sun',
};

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', get label() { return t("跟随"); } },
  { value: 'dark', get label() { return t("深色"); } },
  { value: 'light', get label() { return t("浅色"); } },
];

interface NavItemProps {
  meta: ViewMeta;
  active: boolean;
  collapsed: boolean;
  onSelect(): void;
}

function NavItem({ meta, active, collapsed, onSelect }: NavItemProps) {
  return (
    <li>
      {/* 折叠态用 Tooltip 补名称（展开态 disabled，连包裹层都不生成）；
          className 只做一件事：把包裹层拉到 100% 宽，否则条目会塌成 16px，见 .itemTip 的注释 */}
      <Tooltip
        content={`${t(meta.navLabel)} ${viewShortcut(meta.id)}`}
        side="right"
        disabled={!collapsed}
        className={styles.itemTip}
      >
        <button
          type="button"
          className={cx(styles.item, active && styles.itemActive)}
          onClick={onSelect}
          aria-current={active ? 'page' : undefined}
          aria-label={collapsed ? t(meta.navLabel) : undefined}
        >
          <span className={styles.itemIcon}>
            <Icon name={meta.icon} />
          </span>
          {collapsed ? null : <span className={styles.itemLabel}>{t(meta.navLabel)}</span>}
        </button>
      </Tooltip>
    </li>
  );
}

export default function Sidebar() {
  const view = useNav((state) => state.view);
  const setView = useNav((state) => state.setView);
  const collapsed = useNav((state) => state.sidebarCollapsed);
  const toggleSidebar = useNav((state) => state.toggleSidebar);
  const theme = useNav((state) => state.theme);
  const setTheme = useNav((state) => state.setTheme);

  const upcoming = nextTheme(theme);

  return (
    <nav aria-label={t("主导航")} className={cx(styles.sidebar, collapsed && styles.collapsed)}>
      <div className={styles.brand}>
        <BrandMark collapsed={collapsed} />
      </div>

      {/* 主题三态切换贴在品牌区下方、首个导航条目（Pull Request）之上，不进底部 footer */}
      <div className={styles.themeSlot}>
        {collapsed ? (
          <IconButton
            icon={THEME_ICON[theme]}
            aria-label={t("主题：{0}，切换为{1}", [t(THEME_LABEL[theme]), t(THEME_LABEL[upcoming])])}
            tooltip={t("主题：{0} → {1}", [t(THEME_LABEL[theme]), t(THEME_LABEL[upcoming])])}
            tooltipSide="right"
            onClick={() => setTheme(upcoming)}
          />
        ) : (
          <SegmentedControl
            options={THEME_OPTIONS.map((option) => ({...option, label: t(option.label)}))}
            value={theme}
            onChange={(value) => setTheme(value)}
            aria-label={t("主题")}
            size="sm"
            fullWidth
            className={styles.themeControl}
          />
        )}
        <IconButton
          icon="sidebar"
          aria-label={t(collapsed ? "展开侧栏" : "折叠侧栏")}
          tooltip={t(collapsed ? "展开侧栏 ⌘B" : "折叠侧栏 ⌘B")}
          tooltipSide="right"
          onClick={toggleSidebar}
        />
      </div>

      <div className={styles.groups}>
        {SIDEBAR_GROUPS.map((group) => (
          <section key={group} className={styles.group}>
            {collapsed ? (
              <span className={styles.groupDivider} aria-hidden="true" />
            ) : (
              <h2 className={styles.groupLabel}>{t(GROUP_LABEL[group])}</h2>
            )}
            <ul className={styles.list}>
              {VIEW_LIST.filter((meta) => meta.group === group).map((meta) => (
                <NavItem
                  key={meta.id}
                  meta={meta}
                  active={view === meta.id}
                  collapsed={collapsed}
                  onSelect={() => setView(meta.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className={styles.footer}>
        <ul className={styles.list}>
          <NavItem
            meta={VIEW_META.settings}
            active={view === 'settings'}
            collapsed={collapsed}
            onSelect={() => setView('settings')}
          />
        </ul>


      </div>
    </nav>
  );
}
