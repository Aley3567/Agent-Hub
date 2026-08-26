# Agent-Hub 设计：Rust 管理面 + TUI/CLI + 编排式对话

> 2026-08-24 定稿。Agent-Hub 是本仓库的最终产品形态：一个统一渠道管理器，
> 管理面用 Rust 重写（TUI + CLI 双模式），协议桥保留 Python（`claude-hub.py`），
> 对话能力对标 T3 Code（编排本地 CLI，不自建 harness）。
> 本文记录 11 项已定决策与架构边界；待办里程碑在 `work-queue.md` S11。

## 一句话定位

cc-switch 管「切换」，Agent-Hub 管「切换 + 观测 + 对话」：
渠道财务/健康看板（All API Hub 视角）、事务切换（aisw 安全网）、
TUI 内编排 claude/codex CLI 对话（T3 Code 模式，顺带实测协议桥）。

## 决策树（2026-08-24 烤问定稿，逐条锁定）

| # | 决策点 | 结论 | 一句话理由 |
|---|--------|------|-----------|
| Q1 | Rust/Python 边界 | **管理面 Rust，协议桥留 Python** | 协议层已验证，重写等于重踩已排除的 8 类坑 |
| Q2 | AI 对话角色 | **对标 T3 Code 做完整 chat** | 对话是产品级功能，不是渠道测针 |
| Q3 | GUI 落地 | **复用现有 `UI/` Tauri** | macos 端已修 14 项，设计资产不浪费；等 Rust core 稳定后接 |
| Q4 | 数据层共存 | **共享 cc-switch.db 读写 + schema 版本锁步** | 与 cc-switch-cli 同策略：不得自加上游表/列，本地需求一律 sidecar |
| Q5 | chat 实现 | **编排本地 CLI（T3 模式）** | 不重建 harness；线程 = 独立 git worktree，流式走事件订阅 |
| Q6 | 管理面范围 | **架构留 AppType 位，首版只实现 Claude + Codex** | 其余四工具返回「未实现」，测试面可控 |
| Q7 | claude1/codex1 收场 | **Rust `start` 稳定后退役菜单启动器** | 个人定制仍住 `~/.claude/claude1-personal`，不动 |
| Q8 | 看板数据源 | **只读聚合 hub 已落盘日志**（`~/.cc-switch/logs/`） | 单一埋点来源，不改协议层 |
| Q9 | 分发 | **单二进制 + install.sh** | 与仓库现有 install.sh 模式一致 |
| Q10 | MCP/prompts 管理 | **后置，首版不带** | 用户可继续用 cc-switch 桌面版；DB 表现成，第二刀再接 |
| Q11 | 节奏 | **先写本文 + 最小 scaffold** | 决策固化后再动代码 |

## 调研依据（四路 subagent，2026-08-24）

- **cc-switch-cli**（SaladDay，4.8k star，Rust + ratatui 0.30）——主要参考实现，
  已浅克隆至 `~/Documents/Codex/2026-06-07/cc-switch-cli`。
  照搬：`database/` 整层思路（schema 锁步 + sidecar）、live 配置三向 merge 原子写入、
  `&AppState` 第一参数的 service 风格（CLI 一次性进程与 TUI 长驻进程零成本共用）。
  重写：`tui/data.rs` 7k 行上帝文件是反例；proxy/daemon/webdav 整层不要（Python hub 已有协议层）。
- **All API Hub**（qixing-jk，4.7k star，浏览器扩展）——抄财务视角：
  余额/用量看板、批量测速、粘贴 URL 自动识别。它与 cc-switch 是上下游，不冲突。
- **ai-switch 家族**——抄 aisw 的事务切换 + 失败回滚 + 切换前快照；
  抄 ai-agent-switch 的 route fallback 链、`modelId:apiMode:kind` 寻址、全命令 `--json`；
  抄 ai-cli-switch 的写前测连通 + `.bak` 备份 + 深度合并。
- **T3 Code**（pingdotgg/t3code，20k star，MIT）——对话编排模式：
  不自建 agent，编排已有 CLI；事件溯源 + SQLite；线程 = 独立 worktree。

## 架构

```
claude-hub/                    # 本仓库（Agent-Hub 的家）
├── Cargo.toml                 # Rust workspace 根
├── crates/agent-hub/          # M1 单 crate（lib + bin），GUI 需要时再拆 workspace 多 crate
│   └── src/{main,lib,db,cli,tui}.rs
├── claude-hub.py              # 协议桥 daemon（Python，不动）
├── UI/                        # Tauri GUI（Q3：后续接 Rust core）
└── docs/
```

分层纪律（继承 cc-switch-cli）：

- `cli/` 与 `tui/` 都是薄壳，业务逻辑只在 services 层，签名以 `&AppState` 为第一参数。
- 裸命令进 TUI；stdin/stdout 非 TTY 时退化只读输出，不进交互。
- 所有 CLI 命令支持 `--json`（抄 ai-agent-switch 的自动化契约）。
- TUI 按 Route 枚举 + 每页一个模块组织，**禁止上帝文件**（cc-switch-cli `data.rs` 为戒）。

## 与 cc-switch DB 共存纪律（Q4 的执行细则）

- 共享 `~/.cc-switch/cc-switch.db` 读写；`PRAGMA user_version` 与上游锁步，
  本机实测当前 16，cc-switch-cli 为 17——接入时以「不低于则只读、高于则拒绝」处理。
- 上游 schema 一行不加。Agent-Hub 自有数据（观测聚合、对话线程、worktree 注册表）
  一律 sidecar：`~/.cc-switch/agent-hub.db`。
- `providers.settings_config` 含凭证：list/show 输出永不打印该字段。
- 写路径（切换 provider）= aisw 模式：快照 → 事务写 → 失败整体回滚 → 写后自检。
- **操作前提**（继承 work-queue 已验证事实）：写 cc-switch DB 前必须确认 cc-switch
  桌面版已退出，否则被它的内存 store 回写覆盖。

## 里程碑（细化卡见 work-queue.md S11）

- **M1 只读闭环**：workspace scaffold；`provider list/current`（CLI + TUI 列表页，只读）。
- **M2 事务切换**：`use <id>`（快照/回滚/写后自检）+ `start <id>` 启动 claude/codex。
- **M3 观测看板**：只读聚合 hub 日志，TUI 财务/健康页（余额后置到 Q8 扩展决策）。
- **M4 对话编排**：T3 模式，claude/codex CLI 线程 + worktree 隔离 + 流式订阅。
- **M5 GUI 接线**：UI/ Tauri 复用 Rust core；claude1/codex1 菜单退役评审。

## 明确不做

- 不重写协议层（Q1）；不在上游 schema 加表加列（Q4）；首版不管 MCP/prompts（Q10）；
  不做 WebDAV 同步（cc-switch 桌面版已有）；不碰 Gemini/OpenCode/Hermes/OpenClaw 的
  写路径（Q6，读展示可以）。

## 失效条件

设计文档组不强制，但本文约定：当 M5 完成且 Q1–Q11 全部落入代码与 CLAUDE.md 后，
本文可归档至 `docs/archive/`；任一决策被推翻时先改本文再动代码。
