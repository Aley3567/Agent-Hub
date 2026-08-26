/**
 * 账号池视图，回答「同一渠道的多个账号怎么轮换」（CONTRACT.md 6.5 的文案锚点）。
 *
 * 首版是只读展示（UI/README.md 状态段写死），因此这里没有新建、编辑、删除入口，
 * 也不做任何暗示界面能改的措辞——能改的路径只有 CLI。
 */
import { useMemo } from 'react';
import { EmptyState, Spinner } from '../../components';
import { useApp } from '../../store';
import type { Channel } from '../../types/contract';
import PoolCard from './parts/PoolCard';
import styles from './index.module.css';

/** 建池与查看的 CLI 入口，取自 claude-provider-once.py 的 accounts 子命令用法 */
const CLI_ADD = 'claude1 accounts add <主provider> <账号provider>';
const CLI_LIST = 'claude1 accounts list';

export default function AccountsView() {
  const pools = useApp((state) => state.pools);
  const channels = useApp((state) => state.channels);
  const loading = useApp((state) => state.loading.pools === true);
  const poolsLoaded = useApp((state) => state.loadedKeys.pools === true);
  const reason = useApp((state) => state.error.pools ?? null);
  const refresh = useApp((state) => state.refresh);

  const channelById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of channels) map.set(channel.id, channel);
    return map;
  }, [channels]);

  // 一屏里的相对时间共用同一个基准，避免同一批数据出现「1 分钟前」和「2 分钟前」并列
  const now = useMemo(() => Date.now() / 1000, [pools]);

  // pools 一次都没加载过时（首帧 loading 还没置真）不下「没有账号池」的结论
  const showEmpty = poolsLoaded && pools.length === 0 && !loading && reason === null;

  return (
    <div className={styles.view}>
      <div className={styles.notes}>
        {/* 正文说明 ≤1 行（DESIGN.md 3 节）：具体命令收进空态 hint 的「下一步」里，不在这里堆 */}
        <p className={styles.note}>
          账号池当前为只读展示，编辑请用 CLI；运行期状态（失败次数、冷却剩余）不在池文件里，本页不显示。
        </p>
      </div>

      {reason === null ? null : (
        <p className={styles.error} role="alert">
          {reason}
        </p>
      )}

      {(loading || !poolsLoaded) && pools.length === 0 ? (
        <div className={styles.loading}>
          <Spinner label="正在读取账号池" />
        </div>
      ) : null}

      {showEmpty ? (
        <EmptyState
          icon="accounts"
          title="本机没有配置账号池"
          description="读到的池列表是空的：账号池文件（默认 ~/.cc-switch/claude1-account-pools.json）不存在，或者它的 providers 是空的。"
          action={{ label: '重新读取', icon: 'refresh', onClick: () => void refresh('pools') }}
          hint={
            <>
              用 <code className={styles.code}>{CLI_ADD}</code> 把同一上游的多个 CC Switch 账号编成池，再用{' '}
              <code className={styles.code}>{CLI_LIST}</code> 确认结果。
            </>
          }
        />
      ) : null}

      {pools.length === 0 ? null : (
        <div className={styles.list}>
          {pools.map((pool) => (
            <PoolCard key={pool.providerRef} pool={pool} channelById={channelById} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
