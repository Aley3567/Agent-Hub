/**
 * 一条本机环境信息。
 *
 * 取不到就显示「未检测到」并说清影响，绝不显示空白，也绝不填一个看起来像真的默认值
 * （app_env 在 Rust 侧就是这个口径：检测不到给 false / null）。
 */
import { StatusDot } from '../../../components';
import styles from './EnvRow.module.css';

export interface EnvRowProps {
  label: string;
  /** 检测到的值；null 表示没检测到 */
  value: string | null;
  /** 没检测到时的影响。必填——只说「未检测到」等于没说 */
  missingImpact: string;
  /** 值是技术标识（平台名、版本号）时转等宽 */
  mono?: boolean;
  /** 布尔型检测项：检测到时也给一个绿点，让「有 / 没有」一眼可读 */
  dot?: boolean;
}

export default function EnvRow({ label, value, missingImpact, mono = false, dot = false }: EnvRowProps) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>
        {value === null ? (
          <>
            <StatusDot tone="fail">未检测到</StatusDot>
            <span className={styles.impact}>{missingImpact}</span>
          </>
        ) : dot ? (
          <StatusDot tone="ok">
            <span className={mono ? styles.mono : undefined}>{value}</span>
          </StatusDot>
        ) : (
          <span className={mono ? styles.mono : styles.plain}>{value}</span>
        )}
      </dd>
    </div>
  );
}
