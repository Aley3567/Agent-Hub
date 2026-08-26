/**
 * 单个账号池的只读卡片。
 *
 * 首版账号池只读（UI/README.md 状态段写死），所以这里不存在任何编辑入口。
 * 三条呈现约束：
 *   1. 凭证只显示「已配置 / 未配置」，成员标识渲染前再过一遍前端脱敏（CONTRACT.md 1.2）。
 *   2. 「最近使用的成员」是从用量流水的 account 字段推出来的，不是 hub 运行期的当前绑定，
 *      所以标签就叫「最近使用」，不叫「当前活跃」——推不出来的事不能改个名字冒充。
 *   3. 池文件里没有的东西一律不显示（成员失败次数、冷却剩余），也不用 0 冒充。
 */
import { Badge, Card, StatusDot, Table, Td, Th, type StatusToneInput } from '../../../components';
import { MISSING, cx, formatCount, formatRelative, formatTime, redactSecrets } from '../../../lib';
import type { AccountMember, AccountPool, Channel } from '../../../types/contract';
import styles from './PoolCard.module.css';

export interface PoolCardProps {
  pool: AccountPool;
  /** 渠道按 id 索引，用来把池里的选择器换成人话渠道名与凭证状态 */
  channelById: Map<string, Channel>;
  /** 同一批数据共用的「现在」，保证一屏里的相对时间口径一致 */
  now: number;
}

/**
 * 轮换策略的人话译名。claude1_account_pool.py 的 STRATEGIES 只有这两个值，
 * 其余值 claude1 会直接拒绝加载，所以这里不猜，原码照显示。
 */
const STRATEGY_LABEL: Record<string, string | undefined> = {
  round_robin: '轮询',
  weighted: '按权重',
};

const CREDENTIAL_TITLE = '凭证本身永远不出现在界面上，这里只说有没有配';

interface MemberStatus {
  tone: StatusToneInput;
  text: string;
  hollow: boolean;
  title: string;
}

function memberStatus(member: AccountMember, latestRef: string | null): MemberStatus {
  if (!member.enabled) {
    return {
      tone: 'off',
      text: '已停用',
      hollow: false,
      title: '池文件里 enabled 是 false，claude1 不会选它',
    };
  }
  if (latestRef !== null && member.providerRef === latestRef) {
    return {
      tone: 'current',
      text: '最近使用',
      hollow: false,
      title: '这个池里最后一次记账的成员',
    };
  }
  if (member.turns > 0) {
    return {
      tone: 'ok',
      text: '已启用',
      hollow: false,
      title: '池文件里启用，用量流水里也有过记账',
    };
  }
  return {
    tone: 'ok',
    text: '已启用，未记账',
    hollow: true,
    title: '池文件里启用，但用量流水里还没有它的记录',
  };
}

/** 取最后一次记账的成员。全员都没记过账时返回 null，界面照实说没有 */
function latestMember(members: AccountMember[]): AccountMember | null {
  return members.reduce<AccountMember | null>((best, member) => {
    if (member.lastUsedAt === null) return best;
    if (best === null || best.lastUsedAt === null) return member;
    return member.lastUsedAt > best.lastUsedAt ? member : best;
  }, null);
}

export default function PoolCard({ pool, channelById, now }: PoolCardProps) {
  const primary = pool.resolvedChannelId === null ? undefined : channelById.get(pool.resolvedChannelId);
  const poolRef = redactSecrets(pool.providerRef);
  const strategyLabel = STRATEGY_LABEL[pool.strategy];
  const enabledCount = pool.members.filter((member) => member.enabled).length;
  const latest = latestMember(pool.members);
  const latestRef = latest === null ? null : latest.providerRef;

  return (
    <Card
      flush
      aria-label={`账号池 ${poolRef}`}
      title={
        <span className={styles.titleRow}>
          {primary === undefined ? (
            '未解析的渠道'
          ) : (
            <span className={styles.channelName}>{primary.name}</span>
          )}
          {primary === undefined ? (
            <Badge
              tone="warn"
              mono={false}
              title="池文件里的主 provider 选择器在 CC Switch 数据库里找不到对应渠道"
            >
              未解析
            </Badge>
          ) : null}
          {primary !== undefined && primary.hidden ? (
            <Badge tone="neutral" mono={false} title="这个渠道在渠道视图里被隐藏了，池仍然会用它">
              已隐藏
            </Badge>
          ) : null}
        </span>
      }
      subtitle={<code className={styles.ref}>{poolRef}</code>}
      actions={
        <span className={styles.headerMeta}>
          成员 <span className={styles.num}>{formatCount(pool.members.length)}</span> 个，启用{' '}
          <span className={styles.num}>{formatCount(enabledCount)}</span> 个
        </span>
      }
    >
      <dl className={styles.meta}>
        <div className={styles.metaItem}>
          <dt className={styles.metaLabel}>轮换策略</dt>
          <dd className={styles.metaValue}>
            {strategyLabel === undefined ? `策略 ${pool.strategy} 不是内置值，按原配置展示` : strategyLabel}
            <code className={styles.metaCode}>{pool.strategy}</code>
          </dd>
        </div>
        <div className={styles.metaItem}>
          <dt className={styles.metaLabel} title="成员失败后默认冷却这么久；上游给了 Retry-After 就按上游的来">
            默认冷却
          </dt>
          <dd className={styles.metaValue}>
            {pool.cooldownSeconds === null ? (
              <span className={styles.muted} title="池文件没给这个值，也读不到默认值">
                {MISSING}
              </span>
            ) : (
              <>
                <code className={styles.metaCode}>{formatCount(pool.cooldownSeconds)}</code> 秒
              </>
            )}
          </dd>
        </div>
        <div className={styles.metaItem}>
          <dt className={styles.metaLabel} title="上游给的 Retry-After 再长，也不会超过这个上限">
            冷却上限
          </dt>
          <dd className={styles.metaValue}>
            {pool.maxCooldownSeconds === null ? (
              <span className={styles.muted} title="池文件没给这个值，也读不到默认值">
                {MISSING}
              </span>
            ) : (
              <>
                <code className={styles.metaCode}>{formatCount(pool.maxCooldownSeconds)}</code> 秒
              </>
            )}
          </dd>
        </div>
        <div className={styles.metaItem}>
          <dt
            className={styles.metaLabel}
            title="按用量流水里 account 字段的最后一次记账算出来的，不是 hub 运行期的当前绑定"
          >
            最近使用的成员
          </dt>
          <dd className={styles.metaValue}>
            {latest === null ? (
              <span className={styles.muted}>用量流水里还没有这个池的记账</span>
            ) : (
              <>
                <StatusDot tone="current">
                  <span className={styles.channelName}>{latest.displayName}</span>
                </StatusDot>
                <span className={cx(styles.muted, styles.when)} title={formatTime(latest.lastUsedAt)}>
                  {formatRelative(latest.lastUsedAt, now)}
                </span>
              </>
            )}
          </dd>
        </div>
      </dl>

      {pool.members.length === 0 ? (
        <p className={styles.brokenPool} role="alert">
          这个池没有成员。claude1 要求 members 是非空列表，所以它会拒绝加载这个池——用
          <code className={styles.metaCode}>claude1 accounts list</code>
          检查池文件。
        </p>
      ) : (
        <Table minWidth={880} framed={false}>
          <thead>
            <tr>
              <Th>成员标识</Th>
              <Th>渠道</Th>
              <Th>状态</Th>
              <Th>凭证</Th>
              <Th numeric title="只有 weighted 策略、且在同一优先级组里才起作用">
                权重
              </Th>
              <Th numeric title="数字小的先用；只有同一优先级的成员之间才轮换">
                优先级
              </Th>
              <Th numeric title="用量流水里以这个成员记过账的回合数">
                记账回合
              </Th>
              <Th>最近使用</Th>
            </tr>
          </thead>
          <tbody>
            {pool.members.map((member) => {
              const channel =
                member.resolvedChannelId === null ? undefined : channelById.get(member.resolvedChannelId);
              const status = memberStatus(member, latestRef);
              // 截断后的完整值靠 title 兜住，但 title 也得是脱敏后的那份：
              // 凭证零泄漏是 fail-closed 边界，悬浮提示同样算界面文本
              const memberRef = redactSecrets(member.providerRef);
              return (
                <tr key={member.providerRef}>
                  <Td mono truncate title={memberRef}>
                    {memberRef}
                  </Td>
                  <Td
                    mono
                    truncate
                    title={
                      channel === undefined ? '这个选择器在 CC Switch 数据库里没找到对应渠道' : channel.name
                    }
                  >
                    {channel === undefined ? <span className={styles.muted}>未解析</span> : channel.name}
                  </Td>
                  <Td>
                    <StatusDot tone={status.tone} hollow={status.hollow} title={status.title}>
                      {status.text}
                    </StatusDot>
                  </Td>
                  <Td>
                    {channel === undefined ? (
                      <span className={styles.muted} title="渠道没解析出来，凭证状态也就查不到">
                        未解析
                      </span>
                    ) : (
                      <StatusDot tone={channel.credential === 'configured' ? 'ok' : 'fail'} title={CREDENTIAL_TITLE}>
                        {channel.credential === 'configured' ? '已配置' : '未配置'}
                      </StatusDot>
                    )}
                  </Td>
                  <Td numeric>{formatCount(member.weight)}</Td>
                  <Td numeric>{formatCount(member.priority)}</Td>
                  <Td numeric>{formatCount(member.turns)}</Td>
                  <Td
                    className={styles.when}
                    title={
                      member.lastUsedAt === null ? '用量流水里没有这个成员的记账' : formatTime(member.lastUsedAt)
                    }
                  >
                    {member.lastUsedAt === null ? (
                      <span className={styles.muted}>{MISSING}</span>
                    ) : (
                      formatRelative(member.lastUsedAt, now)
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
