/**
 * 插件视图占位。真正的视图由 view-plugins 代理交付（CONTRACT.md 第 6 节所有权），
 * 这里只保证壳层的 lazy 路由表（CONTRACT.md 第 6.1 节）能找到「默认导出无 props 组件」。
 * 数据通道（store 的 plugins / setPluginEnabled / refresh('plugins')）已就绪，可直接消费。
 */
import { EmptyState } from '../../components';
import { useApp } from '../../store';

export default function PluginsView() {
  const refresh = useApp((state) => state.refresh);
  return (
    <EmptyState
      icon="plugins"
      title="插件视图建设中"
      description="hooks、输出风格、状态栏、权限这些扩展点的管理界面尚未交付，先能看到的是这份占位。"
      action={{ label: '刷新插件列表', icon: 'refresh', onClick: () => void refresh('plugins') }}
    />
  );
}
