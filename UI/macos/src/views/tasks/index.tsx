/**
 * 计划任务视图占位。真正的视图由 view-tasks 代理交付（CONTRACT.md 第 6 节所有权），
 * 这里只保证壳层的 lazy 路由表（CONTRACT.md 第 6.1 节）能找到「默认导出无 props 组件」。
 * 数据通道（store 的 tasks / createTask / updateTask / deleteTask / refresh('tasks')）已就绪。
 */
import { EmptyState } from '../../components';
import { useApp } from '../../store';

export default function TasksView() {
  const refresh = useApp((state) => state.refresh);
  return (
    <EmptyState
      icon="tasks"
      title="计划任务视图建设中"
      description="计划任务的卡片列表与新建 / 编辑对话框尚未交付，先能看到的是这份占位。"
      action={{ label: '刷新任务列表', icon: 'refresh', onClick: () => void refresh('tasks') }}
    />
  );
}
