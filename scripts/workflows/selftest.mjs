// analyze-commits-v6.js 的边界用例 harness。
// workflow runtime 提供 agent/parallel/phase/log/args 全局且允许顶层 return,
// 普通模块环境没有这些——用 AsyncFunction 注入依赖直接执行脚本文本。
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const SRC = readFileSync(new URL('./analyze-commits-v6.js', import.meta.url), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// ---------- fixture ----------

const mkFiles = n => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, changed_lines: 10 }))
const C = (batch, n) => ({ hash: batch + 'abcdef123', batch, desc: `${batch} 描述`, files: mkFiles(n) })
const iss = (severity, description, file = 'src/f0.ts') => ({ severity, file, description, line: 1 })
const analyzeResult = (hash, issues, absence = []) => ({
  hash,
  scope: ['src/f0.ts'],
  matches_description: 'fully',
  correctness_issues: issues,
  absence_claims: absence,
  summary: 'ok',
})
const verdict = (id, v, extra = {}) => ({ finding_id: id, verdict: v, evidence: 'e', ...extra })

// 模拟 workflow runtime:agent 失败返回 null(不抛错),parallel 保序不 filter
async function run(commits, agentImpl) {
  const calls = []
  const logs = []
  const fn = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args',
    SRC.replace('export const meta', 'const meta'))
  const parallel = fns => Promise.all(fns.map(f => Promise.resolve().then(f)))
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    return agentImpl(prompt, opts)
  }
  const result = await fn(agent, parallel, () => {}, m => logs.push(m), { commits })
  return { result, calls, logs }
}

let passed = 0
async function case_(name, fn) {
  await fn()
  passed += 1
  console.log(`ok  ${name}`)
}

// ---------- 用例 ----------

// 1. happy path:>12 文件拆 3 组、refuted 剔除、uncertain/low 保留、low 不进 verify、hash 用注入值
await case_('happy path: 拆分/verify 过滤/low 不进 verify/hash 注入', async () => {
  const { result, calls } = await run([C('R1', 3), C('R2', 13)], (prompt, opts) => {
    const label = opts.label
    if (label === 'analyze:R1')
      return analyzeResult('WRONG', [iss('medium', '甲'), iss('high', '乙'), iss('low', '丙')])
    if (/^analyze:R2:p\d$/.test(label)) return analyzeResult('R2abcdef123', [iss('medium', '丁')])
    if (label === 'verify:R1#1') return verdict(1, 'refuted')
    if (label === 'verify:R1#2') return verdict(2, 'uncertain', { correction: '存疑意见' })
    if (/^verify:R2:p\d#1$/.test(label)) return verdict(1, 'confirmed')
    throw new Error('unexpected agent call: ' + label)
  })
  assert.equal(result.by_commit.length, 2)
  const by = Object.fromEntries(result.by_commit.map(c => [c.batch, c]))
  // agent 回填的 hash 不可信,结果里必须是注入值
  assert.equal(by.R1.hash, 'R1abcdef123')
  // 甲 refuted 剔除,乙 uncertain 保留,丙 low 不进 verify 直接保留
  assert.deepEqual(by.R1.issues.map(i => i.description), ['乙', '丙'])
  assert.equal(by.R1.refuted.length, 1)
  assert.deepEqual(by.R1.uncertain_notes, ['存疑意见'])
  assert.deepEqual(result.split_commits, ['R2'])
  assert.equal(by.R2.parts_total, 3)
  assert.equal(by.R2.parts_done, 3)
  assert.equal(by.R2.matches.length, 3)
  assert.equal(by.R2.issues.length, 3)
  assert.ok(!calls.some(l => l.startsWith('verify:R1#3')), 'low 不应进 verify')
})

// 2. verify agent 失败:对应发现按未核实保留,不静默剔除,且打 warning
await case_('verify 失败:发现保留 + warning(不伪装成核实通过)', async () => {
  const { result, logs } = await run([C('R1', 3)], (prompt, opts) => {
    if (opts.label === 'analyze:R1')
      return analyzeResult('R1abcdef123', [iss('medium', '甲'), iss('medium', '乙')])
    if (opts.label === 'verify:R1#1') return verdict(1, 'confirmed')
    return null // #2 失败
  })
  const c = result.by_commit[0]
  assert.deepEqual(c.issues.map(i => i.description).sort(), ['乙', '甲'])
  assert.equal(c.refuted.length, 0)
  assert.ok(logs.some(l => l.includes('verify 失败')))
})

// 3. finding_id 捏造/重复:回退调用顺序位置,不串位误杀
await case_('finding_id 捏造/重复:回退位置匹配', async () => {
  const { result } = await run([C('R1', 3)], (prompt, opts) => {
    if (opts.label === 'analyze:R1')
      return analyzeResult('R1abcdef123', [iss('medium', '甲'), iss('medium', '乙')])
    if (opts.label === 'verify:R1#1') return verdict(99, 'refuted') // 无效 id → 位置 1
    if (opts.label === 'verify:R1#2') return verdict(1, 'refuted')  // id 1 已被位置 1 占用 → 位置 2
    throw new Error('unexpected agent call: ' + opts.label)
  })
  const c = result.by_commit[0]
  assert.deepEqual(c.issues, [], '两个都应被正确归位并剔除')
  assert.equal(c.refuted.length, 2)
})

// 4. 分析组失败:该组缺失但 commit 仍入账,parts_done/parts_total 暴露不完整
await case_('分析组失败:parts_done 暴露不完整 + warning', async () => {
  const { result, logs } = await run([C('R1', 13)], () => null)
  const c = result.by_commit[0]
  assert.equal(c.parts_total, 3)
  assert.equal(c.parts_done, 0)
  assert.deepEqual(c.issues, [])
  assert.deepEqual(c.matches, [])
  assert.ok(logs.some(l => l.includes('不完整')))
})

// 5. GapCatch:零 issue 且有收尾断言才触发;analyze 返回缺字段兜底
await case_('GapCatch 触发条件 + 缺字段兜底', async () => {
  const { result, calls } = await run([C('R1', 3), C('R2', 3)], (prompt, opts) => {
    if (opts.label === 'analyze:R1') return analyzeResult('R1abcdef123', [], ['断言A'])
    if (opts.label === 'analyze:R2') {
      const r = analyzeResult('R2abcdef123', [])
      delete r.correctness_issues // schema 必填但防御缺字段
      delete r.absence_claims
      return r
    }
    if (opts.label === 'gap:R1') return { hash: 'x', new_issues: [iss('medium', '补')], notes: '复核' }
    throw new Error('unexpected agent call: ' + opts.label)
  })
  const by = Object.fromEntries(result.by_commit.map(c => [c.batch, c]))
  assert.deepEqual(by.R1.issues.map(i => i.description), ['补'])
  assert.equal(by.R1.gap_notes, '复核')
  assert.deepEqual(by.R2.issues, [])
  assert.equal(by.R2.gap_notes, null)
  assert.ok(!calls.includes('gap:R2'), '无收尾断言不应触发 GapCatch')
})

// 6. 空 args.commits:不抛错,空结果
await case_('空 args.commits:不抛错', async () => {
  const { result } = await run([], () => {
    throw new Error('不应调用任何 agent')
  })
  assert.deepEqual(result.by_commit, [])
  assert.deepEqual(result.split_commits, [])
})

console.log(`ALL PASSED (${passed} cases)`)
