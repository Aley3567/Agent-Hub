# CONTEXT.md

本仓库的领域术语表。给在本仓库干活的 agent 与架构审查用：这里只记「名字 → 概念」，
不记状态与规则（那些在 CLAUDE.md 与 docs/）。架构讨论与 `/improve-codebase-architecture`
的产出应使用本表词汇，避免自造新名。

## 协议桥（protocol bridge）

**replay 窗口（replay window）** — native anthropic 出口路径上，一次上游尝试的输出
仍可被无声重放的时间与内存范围。窗口由两个维度界定：字节（`_DeferredDownstream`
的 hold buffer 上限）与秒（thinking-hold deadline）。窗口关闭即 commit：客户端已见
字节，截断只能如实上报（具名 api_error 终局），不能再隐形重放。窗口的全部状态与
「commit 即缴械」invariant 由 `_DeferredDownstream` 单点持有（2026-08-26 起）。
