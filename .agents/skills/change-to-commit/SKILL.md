---
name: change-to-commit
description: 将混合、嘈杂或跨工作流的 Git 工作树恢复为可审查、可验证的行为级提交。用于盘点脏工作树、建立变更账本、拆分同文件 hunks、规划 recovery commits 或建立后续 worktree；普通干净工作树中的单一小改动不必使用。
---

# Change To Commit

目标不是让 `git status` 变空，而是让每个提交只表达一个可说明、可验证、可回退的行为。不要用提交掩盖尚未理解的改动。

## 权限与范围

- 先确认用户要求的是盘点、准备提交、实际提交还是推送。盘点和账本不授权 commit 或 push。
- 保留不属于当前工作流的修改。工作树尚未分类时，不使用 `git add .`、全量 stash、`git clean` 或会覆盖工作树的 reset/checkout。
- bug 的因果修复与运行态证明交给 `$issue-to-proof`；本 skill 只负责让已经理解的改动形成诚实历史。

## 建立基线

先读取仓库指令，再用只读命令记录：

- 当前分支、upstream 与 ahead/behind；
- tracked、untracked、ignored 和已有 staged 变更；
- `git worktree list` 与相关分支；
- 最近提交，以及当前 diff 的文件和 hunk 分布。

大目录先按数量、体积和来源分类，不逐文件漫游。把内容归为候选源码、生成物、外部源码、本地配置或可能含凭证的数据。只有已证明是生成物或外部来源的路径才可建议精确 ignore；ignore 不等于删除。

## 变更账本

按外部可观察行为，而不是按文件名分组。每条记录至少包含：

```text
workstream:
behavior:
owner module / interface:
files or hunks:
tests and proof:
runtime proof:
dependencies:
explicitly excluded:
commit readiness: ready | blocked(reason) | unclassified
```

同一文件属于多个工作流时，标到函数或 hunk。文档声称“完成”但实现仍未跟踪或未提交，是历史一致性缺口，必须显式记录，不能当作已经落地。

## 提交就绪闸门

一条工作流只有同时满足以下条件才是 `ready`：

1. 行为和明确不做的范围可以一句话说明；
2. 每个 staged hunk 都属于该行为，必要的实现、测试和文档也都在；
3. 不依赖未提交的另一工作流；若依赖存在，先提交依赖；
4. 已运行与声明强度相称的检查，运行态缺口被如实标明；
5. staged diff 不含凭证、生成物、外部源码或无关格式化。

身份不明的新 module、验证合同不同的平台、以及无法安全拆开的交叠 hunk，保持 `blocked`，不要靠一个“大整理提交”吞掉。

## 精确暂存与 checkpoint

用户授权实际提交后：

1. 对完整归属文件使用 `git add -- <paths>`；混合文件使用 `git add -p -- <paths>`。
2. 检查 `git diff --cached --name-status`、`git diff --cached` 和 `git diff --cached --check`。
3. 从暂存内容运行最窄相关测试，再运行该 module 的约定检查。
4. 提交信息描述行为或规则，不写笼统的 `cleanup`、`misc fixes`。
5. 提交后重新查看 status，确认剩余改动仍在且分类没有被破坏。

不要为了制造干净状态而把未验证内容放进 checkpoint。恢复性提交也是产品历史，质量要求不降低。

## 后续隔离

只有当前工作有了可恢复的提交基线后，才为新工作流创建 worktree。一个 worktree 对应一个 issue 或一个产品线；不要从同一脏目录复制文件到多个 worktree，也不要让多个 worktree 同时修改同一规则所有者。

结束时报告：已检查与已暂存/提交的范围、每个工作流的 readiness、执行过的验证、剩余未分类内容、是否产生 commit/push。没有做的动作要明确说没有做。
