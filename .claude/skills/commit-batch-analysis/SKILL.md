---
name: commit-batch-analysis
description: 用多 agent workflow 编排分析一批 git 提交:核对各 commit 实际 diff 与批次描述一致性、找正确性问题、对抗核实。用于「用 workflow 分析这批提交」「快速审查这 N 个 commit」类请求。编排骨架与纪律直接复用 scripts/workflows/analyze-commits-v6.js,不要从零发明。
---

# Commit 批量分析 Workflow

六轮迭代换来的编排配置,已用 golden set 验证(召回 100% / 精度 80% / token 545k)。
本 skill 的职责是让你在**拿活阶段**做对三件事:喂对 args、核对结果完整性、按目标线判定。
编排逻辑本体在 `scripts/workflows/analyze-commits-v6.js`,先用 Read 通读一遍再动手。

## 何时用 / 何时不用

用:一批(约 5-15 个)已知 hash 的提交,要做 diff vs 描述核对 + 正确性审查。
不用:单个提交(直接人工看 diff);未知范围的全库审计(先明确对象集);
只查性能不查正确性(纪律 prompt 面向正确性)。

## 1. 构造 args(必做,这是唯一需要你写的部分)

Workflow 调用时传 `scriptPath` + `args`,args 形状:

```json
{
  "commits": [
    {
      "hash": "<40 位或短 hash>",
      "batch": "R1",
      "desc": "批次表里对该提交的一句话描述",
      "files": [
        { "path": "UI/macos/...", "changed_lines": 42 }
      ]
    }
  ]
}
```

生成方式:`git log --stat` 或逐个 `git show --stat <hash>` 取文件清单与行数。
**files 必须完整**——文件地图注入 analyze prompt,漏一个文件该文件就无人负责。
hash 建议用短 hash,但脚本层已做归一(`hash` 字段结果里用注入值,不信 agent 回填)。

`desc` 直接用用户给的批次表原文;用户没给描述时,用 commit message 第一行。

## 2. 调用与恢复

```text
Workflow({ scriptPath: "scripts/workflows/analyze-commits-v6.js", args: {...} })
```

失败恢复用 resume:**原样复用首次的 args 对象**(重新序列化会全量 cache miss,
曾因此白烧 545k token)。额度耗尽类失败(403)表现为部分 agent 返回 null——
脚本层已按「失败不伪装」处理,见下一步核对。

## 3. 核对结果完整性(消费结果前必做)

脚本层已暴露可核对字段,但**你要主动核对**:

1. `by_commit.length` === 提交数——少一个就是有 commit 整链失败;
2. 每个 commit 的 `parts_done === parts_total`——不等则该 commit 结果不完整,报告里如实写;
3. 大量 `<failures>` 块 = 额度/上游故障,先补环境再 resume,不要基于残缺结果下结论。

## 4. 判定与报告

有 golden set 时用 `python3 scripts/wf-eval.py <output.json> scripts/wf-golden-r1-r10.json`
出四指标。没有 golden set 时(常态):**首次 run 的 confirmed 发现即是该批次的 golden
set 种子**——对每条 medium+ 发现人工核实一次,把「confirmed/refuted + match 关键词」
追加进 golden set 文件,后续迭代才有判定基准。

报告按 commit 分组:matches_description 一致性结论、issue 清单(带 severity/file/line)、
refuted 与 uncertain_notes 单列(核实被推翻/存疑的,不混入正式发现)。

## 编排纪律(改脚本前先读)

这些配置是实验对照的结果,改前先跑 baseline:

- **预算 15+5×文件不封顶**:v5 砍预算只砍召回不省 token(token = agent 数 × 上下文规模);
- **GROUP_SIZE=6 / SPLIT_THRESHOLD=12**:更小的小组(v5 的 4)损失跨文件视野;
- **verify 判决纪律**(prompt 原文在脚本里):只有事实前提被推翻才 refuted,
  分量存疑判 uncertain 保留——这是唯一一次召回损失(误杀)的来源;
- **墙钟下限被上游停顿方差锁定**(单 agent 300-800s):编排优化只能压到最慢单链,
  目标线留 1.5 倍余量;
- 脚本的边界行为(verify 失败保留、finding_id 回退位置、parts_done 计数)由
  `scripts/workflows/selftest.mjs` 的 6 个用例钉住,改完跑 `node scripts/workflows/selftest.mjs`。
