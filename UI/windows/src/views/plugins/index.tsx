/**
 * 插件视图，回答「hooks、输出风格、状态栏、权限这些扩展点各自是什么状态」
 * （CONTRACT.md 6.5 的文案锚点）。形态按 DESIGN.md 4.6：按 kind 五类分组的分组列表，
 * 不用表格。
 *
 * 这一页的信任前提写在顶上一行里：全局项的开关落到 claude1-config.json 的本地覆盖；
 * 渠道级项来自 settings_config，桌面端对 CC Switch 数据库只读——它在这一页永远不可开，
 * 所以只读项不给禁用的 Switch（DESIGN.md 4.6「可写与只读的分叉」）。
 *
 * 三件套：error.plugins 原文（role=alert）、Spinner 加载态、loadedKeys 门控的空态；
 * 壳层刷新（⌘R）经 registerViewReload 转到 refresh('plugins')，卸载时注销。
 */
import { useEffect, useMemo } from 'react';
import { Button, EmptyState, Icon, SectionHeader, Spinner } from '../../components';
import { useApp } from '../../store';
import { useNav } from '../../store/nav';
import type { PluginItem } from '../../types/contract';
import PluginRow from './parts/PluginRow';
import styles from './index.module.css';

type PluginKind = PluginItem['kind'];

/** 五类的固定顺序与中文组名（DESIGN.md 4.6：组名中文人话） */
const KIND_ORDER: PluginKind[] = ['hook', 'outputStyle', 'statusLine', 'permissions', 'mcp'];

const KIND_LABEL: Record<PluginKind, string> = {
  hook: '钩子',
  outputStyle: '输出风格',
  statusLine: '状态栏',
  permissions: '权限',
  mcp: 'MCP 服务器',
};

export default function PluginsView() {
  const plugins = useApp((state) => state.plugins);
  const loading = useApp((state) => state.loading.plugins === true);
  const loaded = useApp((state) => state.loadedKeys.plugins === true);
  const reason = useApp((state) => state.error.plugins ?? null);
  const refresh = useApp((state) => state.refresh);
  const registerViewReload = useNav((state) => state.registerViewReload);

  // 壳层刷新（⌘R / ViewHeader）整页转发到这里，口径与视图内刷新按钮一致；卸载必须注销
  useEffect(() => {
    registerViewReload('plugins', () => refresh('plugins'));
    return () => registerViewReload('plugins', null);
  }, [registerViewReload, refresh]);

  const grouped = useMemo(() => {
    const out: Record<PluginKind, PluginItem[]> = {
      hook: [],
      outputStyle: [],
      statusLine: [],
      permissions: [],
      mcp: [],
    };
    for (const item of plugins) out[item.kind].push(item);
    // 组内可写项（global）在前、只读项（channel）在后，各自保持源顺序
    for (const kind of KIND_ORDER) {
      out[kind].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1));
    }
    return out;
  }, [plugins]);

  // 空态只在加载过一轮之后出现：loadedKeys.plugins 没立起来之前，首帧不许闪空态
  const showEmpty = loaded && plugins.length === 0 && !loading && reason === null;

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        {/* 正文说明就这一行（DESIGN.md 3：每视图正文说明 ≤1 行） */}
        <p className={styles.scope}>
          <Icon name="lock" size={14} className={styles.scopeIcon} />
          全局项的开关写入 claude1-config.json；渠道级项来自 settings_config，数据库只读。
        </p>
        <Button
          variant="secondary"
          size="sm"
          icon="refresh"
          loading={loading}
          onClick={() => void refresh('plugins')}
        >
          刷新
        </Button>
      </div>

      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {(loading || !loaded) && plugins.length === 0 ? (
        <div className={styles.loading}>
          <Spinner label="正在读取插件清单" />
        </div>
      ) : null}

      {showEmpty ? (
        <EmptyState
          icon="plugins"
          title="没有配置任何扩展点"
          description="全局配置与所有渠道的 settings_config 里都没有 hooks、输出风格、状态栏、权限或 MCP 服务器，所以这份清单是空的。"
          action={{ label: '重新读取', icon: 'refresh', onClick: () => void refresh('plugins') }}
          hint="在 Claude Code 的 settings.json 或 CC Switch 的渠道配置里加上扩展点后，重新读取就能在这里看到对应条目。"
        />
      ) : null}

      {KIND_ORDER.map((kind) => {
        const items = grouped[kind];
        if (items.length === 0) return null;
        return (
          <section className={styles.group} key={kind}>
            <SectionHeader level={3} title={KIND_LABEL[kind]} count={items.length} />
            <ul className={styles.list}>
              {items.map((item) => (
                <PluginRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
