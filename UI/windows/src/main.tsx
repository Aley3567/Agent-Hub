/**
 * 应用入口。样式的引入顺序是刻意的：先 tokens.css 定义变量，再 global.css 使用它们。
 * 挂载前先把持久化的主题偏好落到 documentElement，避免第一帧闪成默认深色再跳浅色。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/global.css';
import App from './App';
import { applyTheme, readStoredTheme } from './store/nav';

applyTheme(readStoredTheme());

const container = document.getElementById('root');
if (!container) {
  // 挂载点没了说明 index.html 被改坏了，直接把原因说清楚，不静默留白屏
  throw new Error('找不到挂载点 #root，index.html 可能被改动');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
