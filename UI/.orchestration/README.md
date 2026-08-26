# 编排目录

桌面端 UI 重构的 workflow 脚本。**跑完全部批次、确认不再需要 `resumeFromRunId` 续跑之后，
删掉这个目录**——续跑依赖脚本文件存在，所以别在跑完之前清理。

## 为什么脚本要落盘

`direct` + `claude-opus-5` 这条渠道的上游对流有 **120 秒硬掐断**。编排一次 workflow 要在单个
`tool_use` 里生成几万字符的 script，生成时长必然越过这条线，于是每次都断在同一位置。
所以做法是：**分批 heredoc 写盘 → 语法校验 → `Workflow({scriptPath})`**，
让每次响应都远离 120 秒。

## 语法校验

脚本体跑在 async 上下文里，顶层 `return` 合法，`node --check` 会误报
`Illegal return statement`。正确做法：

```bash
python3 -c "
from pathlib import Path
src = Path('batchN.mjs').read_text(encoding='utf-8')
Path('/tmp/.c.mjs').write_text(
    'async function __wf(agent,parallel,log,phase,args,budget,workflow,pipeline){\n'
    + src.replace('export const meta','const meta',1) + '\n}\n', encoding='utf-8')
"
node --check /tmp/.c.mjs && rm -f /tmp/.c.mjs
```

## 脚本清单

| 脚本 | agent | 状态 |
|---|---|---|
| `batch3-table.mjs` | 6 | 已跑完（`wf_6d30e8ac-65c`），22 项复核发现已全部处理 |
| `batch4-motion.mjs` | 9 | Apply 之后被中断（`wf_12e65279-def`），**Verify 三路未跑** |
| `batch4-verify.mjs` | 3 | 补跑第四批复核用。**下一步就跑它** |
| `batch5-ux.mjs` | 10 | 就绪未跑 |
| `batch6-windows.mjs` | 12 | 就绪未跑 |

## 必须串行

四批改的是同一批文件：第四批要给第三批刚改的 `Table.module.css` 加 transition，
第五批要动第四批定的时长语义，第六批要移植前面所有批次的成果。
**并行会直接互相覆盖。** 每批跑完先验证再开下一批。

## 每批跑之前

做一份快照，用于跑完后的越界检查（`UI/` 整个目录还是 untracked，没有 git diff 可用）：

```bash
SNAP=/tmp/ui-batchN-snapshot
rm -rf "$SNAP" && mkdir -p "$SNAP"
cp -R UI/macos/src "$SNAP/src" && cp UI/DESIGN.md "$SNAP/DESIGN.md"
```

跑完 `diff -rq "$SNAP/src" UI/macos/src` 列出变动文件，逐个确认在该批的所有权范围内。

## 每批跑完的门禁

```bash
UI/macos/node_modules/.bin/tsc --noEmit -p UI/macos/tsconfig.json   # 改了 tsx 必跑
python3 UI/tools/token-drift.py UI                  # DESIGN.md ↔ macos tokens.css
python3 UI/tools/border-audit.py UI/macos/src       # 边框承重
python3 UI/tools/token-parity.py UI                 # 两侧 token 对等（第六批用）
python3 -m unittest discover -s tests -p 'test_*.py'  # 项目根验证命令
```

## 写 prompt 时的两条教训

**规则条文和分组 hint 必须自一致。** 第二批因为条文说「两栏之间的 border 保持 subtle」、
而给 shell 组的 hint 又说「大区分界视为容器边界」，fix agent 跟 hint 改了 3 处，
verify agent 跟条文全部回退，白跑一组。

**每批的「不许回退」清单要按上一批的实际实现写，不是按当初的计划写。** 第三批复核后
sticky 分隔线从 `border-left` 换成了 `box-shadow: inset`，如果第四批的清单还写着
「左侧 1px border 分隔线」，verify 就会把修复当成偏差报出来，fix agent 也可能改回去。
