export const meta = {
  name: 'analyze-commits-v6',
  description: 'commit 批次分析 v6:文件地图 args 注入 + per-commit 链式流水线 + 组内 verify + 大提交优先抢槽',
  phases: [
    { title: 'Analyze', detail: 'args 注入文件地图,预算 15+5×文件,>12 文件拆 6 文件小组' },
    { title: 'GapCatch', detail: '零 issue 且有收尾断言的 commit 宽口径补漏' },
    { title: 'Verify', detail: '每组 medium+ 发现随组完成立即对抗核实;refuted 剔除,verify 失败保留' },
  ],
}

const REPO = '/Users/admin/Desktop/claude-hub'
// 大提交优先:关键链先抢并发槽
const MAP = [...(args.commits || [])].sort((a, b) => (b.files || []).length - (a.files || []).length)

const SPLIT_THRESHOLD = 12
const GROUP_SIZE = 6
// 预算随负责文件数自适应。v5 反面实验已证明:砍预算只砍召回,不省 token——
// token 由 agent 数 × 上下文规模决定,这里不封顶。
const budget = n => 15 + 5 * n

// ---------- schema ----------

const ISSUE_SCHEMA = {
  type: 'object',
  required: ['severity', 'file', 'description'],
  properties: {
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    file: { type: 'string' },
    line: { type: 'integer' },
    description: { type: 'string', description: '≤4 句,含定位与触发条件' },
  },
}

const ANALYZE_SCHEMA = {
  type: 'object',
  required: ['hash', 'scope', 'matches_description', 'correctness_issues', 'absence_claims', 'summary'],
  properties: {
    hash: { type: 'string' },
    scope: { type: 'array', items: { type: 'string' } },
    matches_description: { type: 'string', enum: ['fully', 'partially', 'mismatch'] },
    correctness_issues: { type: 'array', items: ISSUE_SCHEMA },
    absence_claims: {
      type: 'array',
      items: { type: 'string' },
      description: '你做出的「不存在别的问题/路径」类断言,逐条列出,供补漏员攻击',
    },
    summary: { type: 'string', description: '≤3 句' },
  },
}

const GAP_SCHEMA = {
  type: 'object',
  required: ['hash', 'new_issues'],
  properties: {
    hash: { type: 'string' },
    new_issues: { type: 'array', items: ISSUE_SCHEMA },
    notes: { type: 'string', description: '对被攻击断言的复核结论,≤3 句' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['finding_id', 'verdict', 'evidence'],
  properties: {
    finding_id: { type: 'integer' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    evidence: { type: 'string', description: '≤4 句,行号级证据链' },
    correction: { type: 'string' },
  },
}

// ---------- 纯逻辑 ----------

const isMediumPlus = i => i.severity === 'medium' || i.severity === 'high'

// 超过 SPLIT_THRESHOLD 个文件拆成 GROUP_SIZE 一组的若干小组
const groupFiles = files =>
  files.length > SPLIT_THRESHOLD
    ? Array.from({ length: Math.ceil(files.length / GROUP_SIZE) }, (_, i) =>
        files.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE))
    : [files]

// 对抗核实结果回填。verdicts 与 toVerify 保序等长,失败位为 null(不许 filter 掉,
// 否则后续位置错位);finding_id 在有效范围内优先采用,无效或重复则回退调用顺序位置
// (agent 会捏造 id);verify 缺席的发现保留——失败绝不伪装成核实通过后剔除。
function applyVerdicts(issues, toVerify, verdicts) {
  const byId = new Map()
  verdicts.forEach((v, i) => {
    if (!v) return
    const claimed = Number.isInteger(v.finding_id) && v.finding_id >= 1 && v.finding_id <= toVerify.length
      ? v.finding_id
      : i + 1
    if (!byId.has(claimed)) byId.set(claimed, v)
    // id 被抢走(捏造/重复)→ 回退自身调用位置;位置也被占则丢弃,按 verify 失败保留
    else if (claimed !== i + 1 && !byId.has(i + 1)) byId.set(i + 1, v)
  })
  const survived = issues.filter(i => {
    if (!isMediumPlus(i)) return true
    const t = toVerify.find(x => x.description === i.description && x.file === i.file)
    const v = t && byId.get(t.id)
    return !v || v.verdict !== 'refuted'
  })
  const present = verdicts.filter(Boolean)
  return {
    survived,
    refuted: present.filter(v => v.verdict === 'refuted'),
    uncertain: present.filter(v => v.verdict === 'uncertain'),
  }
}

// ---------- prompt ----------

const DISCIPLINE = b => `取材纪律(必须遵守):
- 文件地图已注入下方,不要自己再跑 --stat 或搜文件位置。
- 取某文件的 diff 用 git show <hash> -- <path>,一次只取一个文件。
- 看当前文件状态用 Read 带 offset/limit 只读相关段落,不整文件翻。
- 工具调用预算 ${b} 次,接近预算时收束结论。
- 仓库原则:默认放行例外才拒;失败绝不伪装成成功。问题只列有行号级证据的,没有就空数组,不凑数。
- 你做的每个「不存在别的 X」类收尾断言,单独填进 absence_claims——这些断言会被另一位分析员专门攻击。`

function analyzePrompt(c, group, gi, groupCount) {
  const split = groupCount > 1
  return `你在分析 git 仓库 ${REPO} 中的一个提交。只读分析,不修改文件。

提交: ${c.hash} (批次 ${c.batch})
批次描述: ${c.desc}

文件地图(本提交全部改动):
${(c.files || []).map(f => `  ${f.path} (${f.changed_lines} 行)`).join('\n')}

你负责的范围${split ? `(拆分任务 ${gi + 1}/${groupCount},只报与这些文件直接相关的问题)` : '(全部文件)'}:
${group.map(f => `  ${f.path}`).join('\n')}

${DISCIPLINE(budget(group.length))}

步骤:按范围逐文件取 diff 核对与描述是否一致;在改动范围内找正确性问题(逻辑/边界/竞态/错误处理/修复不彻底)。双侧(macos/windows)镜像改动只需抽查一侧+确认另一侧文件在地图中即可。
你的最终输出就是结构化数据本身。返回的 hash 字段填 "${c.hash}"。`
}

function verifyPrompt(c, f) {
  return `你是对抗性核实员,在 git 仓库 ${REPO} 只读工作。前一位分析员对提交 ${c.hash} 报了如下问题(问题编号 #${f.id},返回结果时 finding_id 必须原样填 #${f.id} 的数字),你的职责是试图推翻它,而不是确认它:

问题 #${f.id} | 严重度 ${f.severity} | 文件 ${f.file}${f.line ? ':' + f.line : ''}
${f.description}

核实要求:
1. 亲自取证据:git show ${c.hash} -- ${f.file} 与当前文件相关段落都要看,行号以当前 HEAD 为准。
2. 攻击每个事实前提:正则内容、调用路径、状态生命周期、触发条件是否属实?有没有它没看到的兜底逻辑(本地 state、useEffect 依赖、其他渲染路径)?
3. 判决纪律:只有当你推翻了发现的事实前提(代码/调用链/数据与描述不符)才判 refuted;若行为确实存在、只是严重度或影响面被高估,判 uncertain 并在 correction 给意见——uncertain 的发现保留,不剔除。证据不足也判 uncertain,不硬站队。
4. 工具调用预算 20 次。
你的最终输出就是结构化数据本身。`
}

function gapPrompt(c, files, absence) {
  return `你是宽口径补漏分析员,在 git 仓库 ${REPO} 只读工作。一位严格的同行刚分析了提交 ${c.hash}(批次 ${c.batch}),结论是「无正确性问题」,并留下这些收尾断言:
${absence.map(a => `  - ${a}`).join('\n')}

批次描述: ${c.desc}
涉及文件:
${files.map(f => `  ${f.path}`).join('\n')}

你的职责:专门找严格分析员会提前收束漏掉的东西——那些断言里最可疑的一条,逐条攻击它;再检查改动文件与本提交未改动的邻居文件之间的跨文件路径(第二道闸的正则缺口、本地回显/落库双源口径、生命周期与刷新的错配)。双侧镜像只查一侧。
工具调用预算 15 次,Read 带 offset/limit 切片。有行号级证据才报,没有就空数组。你的最终输出就是结构化数据本身。`
}

// ---------- 编排 ----------

// 组内流水线:analyze 一返回,该组的 medium+ 立即进 verify,不等同 commit 其他组
async function analyzePart(c, group, gi, groupCount) {
  const suffix = groupCount > 1 ? ':p' + (gi + 1) : ''
  const part = await agent(analyzePrompt(c, group, gi, groupCount), {
    label: `analyze:${c.batch}${suffix}`,
    phase: 'Analyze',
    schema: ANALYZE_SCHEMA,
  })
  if (!part) return null

  const issues = part.correctness_issues || []
  const toVerify = issues.filter(isMediumPlus).map((i, idx) => ({ id: idx + 1, ...i }))
  const verdicts = toVerify.length
    ? await parallel(toVerify.map(f => () => agent(verifyPrompt(c, f), {
        label: `verify:${c.batch}${suffix}#${f.id}`,
        phase: 'Verify',
        schema: VERIFY_SCHEMA,
      })))
    : []
  const failed = verdicts.filter(v => !v).length
  if (failed) log(`${c.batch}${suffix}: ${failed} 个 verify 失败,对应发现按未核实保留`)

  const { survived, refuted, uncertain } = applyVerdicts(issues, toVerify, verdicts)
  return {
    part: { ...part, correctness_issues: survived },
    refuted,
    uncertainNotes: uncertain.map(v => v.correction || v.evidence),
  }
}

async function analyzeCommit(c) {
  const files = c.files || []
  const groups = groupFiles(files)

  const partResults = (await parallel(groups.map((g, gi) => () => analyzePart(c, g, gi, groups.length))))
    .filter(Boolean)
  const parts = partResults.map(r => r.part)
  if (partResults.length < groups.length)
    log(`${c.batch}: ${groups.length - partResults.length}/${groups.length} 个分析组失败,结果不完整`)

  const issues = parts.flatMap(p => p.correctness_issues || [])
  const absence = parts.flatMap(p => p.absence_claims || [])

  // GapCatch:零 issue 且分析员留下了收尾断言才触发——断言是补漏的攻击面
  let gapNotes = null
  let gapIssues = []
  if (issues.length === 0 && absence.length > 0) {
    phase('GapCatch')
    const gap = await agent(gapPrompt(c, files, absence), {
      label: `gap:${c.batch}`,
      phase: 'GapCatch',
      schema: GAP_SCHEMA,
    })
    if (gap) {
      gapIssues = gap.new_issues || []
      gapNotes = gap.notes || null
    }
  }

  return {
    // hash 用注入值,不信 agent 回填——长短 hash 混用曾导致聚合丢结果
    hash: c.hash,
    batch: c.batch,
    // 消费结果前核对这两个数:agent 挂掉后 workflow 照常出「看起来正常」的部分结果
    parts_done: partResults.length,
    parts_total: groups.length,
    matches: parts.map(p => p.matches_description),
    issues: issues.concat(gapIssues),
    refuted: partResults.flatMap(r => r.refuted),
    uncertain_notes: partResults.flatMap(r => r.uncertainNotes),
    gap_notes: gapNotes,
    summaries: parts.map(p => p.summary),
  }
}

phase('Analyze')
const results = (await parallel(MAP.map(c => () => analyzeCommit(c)))).filter(Boolean)
log(`收束完成 ${results.length}/${MAP.length} 个 commit`)

return {
  by_commit: results,
  split_commits: MAP.filter(c => (c.files || []).length > SPLIT_THRESHOLD).map(c => c.batch),
}
