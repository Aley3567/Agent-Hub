/**
 * 对话视图占位。真正的视图由 view-chat 代理交付（CONTRACT.md 第 6 节所有权），
 * 这里只保证壳层的 lazy 路由表（CONTRACT.md 第 6.1 节）能找到「默认导出无 props 组件」。
 * 数据通道（store 的 chatSessions / sendChatMessage / refresh('chat')）已就绪，可直接消费。
 */
import { EmptyState } from '../../components';
import { useApp } from '../../store';

export default function ChatView() {
  const refresh = useApp((state) => state.refresh);
  return (
    <EmptyState
      icon="chat"
      title="对话视图建设中"
      description="会话、消息流与流式回复的界面尚未交付；数据通道已就绪，先能看到的是这份占位。"
      action={{ label: '刷新会话列表', icon: 'refresh', onClick: () => void refresh('chat') }}
    />
  );
}
