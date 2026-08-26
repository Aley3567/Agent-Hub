/**
 * 视图懒加载时的兜底：一条 1px 顶部 accent 进度线，不做骨架屏（DESIGN.md 第 2.5 节）。
 * 样式类 app-progress 由 styles/global.css 提供，两侧平台共用同一个类名。
 */
import styles from './RouteProgress.module.css';

export default function RouteProgress() {
  return (
    <div className={styles.host}>
      <div className="app-progress" role="progressbar" aria-label="正在加载视图" />
    </div>
  );
}
