/**
 * 主导航侧栏。展开 --sidebar-w(232px)，折叠 --sidebar-w-collapsed(56px) 只留图标（DESIGN.md 第 3 节）。
 * 分三组：会话（对话、渠道、槽位）、观测（用量、诊断、账号池、体检）、扩展（插件、任务）；
 * 底部固定「设置」入口与主题三态切换。
 * 折叠态每一项都靠 Tooltip 说明自己是谁，否则只剩一排看不懂的图标。
 */
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
  { value: 'system', label: '跟随' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
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
        content={`${meta.navLabel} ${viewShortcut(meta.id)}`}
        side="right"
        disabled={!collapsed}
        className={styles.itemTip}
      >
        <button
          type="button"
          className={cx(styles.item, active && styles.itemActive)}
          onClick={onSelect}
          aria-current={active ? 'page' : undefined}
          aria-label={collapsed ? meta.navLabel : undefined}
        >
          <span className={styles.itemIcon}>
            <Icon name={meta.icon} />
          </span>
          {collapsed ? null : <span className={styles.itemLabel}>{meta.navLabel}</span>}
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
    <nav aria-label="主导航" className={cx(styles.sidebar, collapsed && styles.collapsed)}>
      <div className={styles.brand}>
        <BrandMark collapsed={collapsed} />
      </div>

      <div className={styles.groups}>
        {SIDEBAR_GROUPS.map((group) => (
          <section key={group} className={styles.group}>
            {collapsed ? (
              <span className={styles.groupDivider} aria-hidden="true" />
            ) : (
              <h2 className={styles.groupLabel}>{GROUP_LABEL[group]}</h2>
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

        {collapsed ? (
          <div className={styles.footerActions}>
            <IconButton
              icon={THEME_ICON[theme]}
              aria-label={`主题：${THEME_LABEL[theme]}，切换为${THEME_LABEL[upcoming]}`}
              tooltip={`主题：${THEME_LABEL[theme]} → ${THEME_LABEL[upcoming]}`}
              tooltipSide="right"
              onClick={() => setTheme(upcoming)}
            />
            <IconButton
              icon="sidebar"
              aria-label="展开侧栏"
              tooltip="展开侧栏 Ctrl+B"
              tooltipSide="right"
              onClick={toggleSidebar}
            />
          </div>
        ) : (
          <div className={styles.footerActions}>
            <SegmentedControl
              options={THEME_OPTIONS}
              value={theme}
              onChange={(value) => setTheme(value)}
              aria-label="主题"
              size="sm"
            />
            <IconButton
              icon="sidebar"
              aria-label="折叠侧栏"
              tooltip="折叠侧栏 Ctrl+B"
              tooltipSide="top"
              onClick={toggleSidebar}
            />
          </div>
        )}
      </div>
    </nav>
  );
}
