# CLAUDE.md

给在本仓库干活的 agent。本文只立规矩与 `docs/` 索引,不记项目状态——状态会过期,规则不会。细节都在 `docs/`,需要时现读原文,不要凭本文的转述或自己的记忆行事。

**一句话版本**:协议代码**默认放行**,reject 只留给安全与因果;错误原样暴露、绝不伪装。

**验证**:`python3 -m unittest discover -s tests -p 'test_*.py'`。

## Issue 修复

非显然、复发、跨路径、间歇性或仅在真实运行态出现的问题,必须使用项目 skill
`/issue-to-proof` 从症状推进到因果修复与证据闭环。原因已被现有失败测试直接证明的机械故障
可走短路径。详细流程只维护在 skill 中,不要复制回本文;外部环境问题未完成同环境验证时,
状态只能写「代码完成,运行态未验证」,不能写「已修复」。

## 版本控制与 module 归属

工作树混有多个 issue、产品线或同文件异类 hunk 时,使用 `/change-to-commit` 先建立行为级
变更账本,再精确暂存与验证;未分类期间禁止 `git add .`、全量 stash、`git clean` 和会覆盖
工作树的 reset/checkout。提交表达一个行为与证据,不是为了把 status 清空。

涉及文件修改的任务,开工时主动报告分支、与 upstream 的差异及相关既有修改;一个行为完成且
相关检查通过后,默认主动创建本地 commit 并报告 hash,无需等用户再下 Git 指令。无法从既有
修改中安全分离时保持未暂存并说明重叠。push、merge、rebase、amend、改写 ref、删分支和
清理 worktree 均不属于该默认授权,必须另行确认。

根 Python 文件是当前运行时,协议语义只由 `claude-hub.py` / `claude1_protocol.py` 所有;
`crates/agent-hub/` 是 Rust 管理面;`UI/macos/` 与 `UI/windows/` 独立验证;
`gateway/` 在产品身份明确前视为独立 Go 实验,不得静默成为第二套 canonical 协议实现。

## 总规则:默认放行,例外才拒

本仓库协议桥历史上 fail-closed 过头:上游流中途换 id、响应多个新字段、SSE 来个自定义事件、tool 参数不是 object,一律拒绝——上游的任何方言都变成用户可见的"id/response 不兼容"。

写或改协议代码时,对每一段上游数据只做三选一:

1. **能无损转** → 转。
2. **有损但能用** → 放行,记 `HUB_DEGRADE_*` warning,保证事后能在 errors/usage 里查到。这是默认档位。
3. **会出安全或因果事故** → 才拒,且必须能一句话说清防的是什么灾难。"我不认识这个字段"不是理由。

## 三条覆盖大多数场景的判断

- **错误**:上游的状态码和错误体尽量原样还给下游,不包装、不裁剪语义(脱敏只针对凭证);但失败绝不伪装成成功——断流不补 `message_stop`,工具调用丢了不伪装 `completed`。
- **id**:上游给了 message id / tool_use id 就用上游的;确实没有才本地生成,并记 `HUB_DEGRADE_SYNTHETIC_*`。
- **流**:收到什么转什么,未知事件跳过;终态只能来自上游的真实终态。

## 仍然 fail-closed 的边界

凭证(只读 CC Switch DB、不落盘、不进日志)、tool_use/tool_result 因果校验(防止错乱调用真实工具)、本地鉴权与 `0600` 文件权限。宽容只针对上游数据形状的多样性,不针对安全边界。

## 硬约束

- **继承优先于发明**:实现思路默认采用 cc-switch 已验证的做法(调研:`docs/cc-switch-implementation-research.md`;本机克隆:`~/Documents/Codex/2026-06-07/cc-switch`),动手前先对照对应实现。偏离必须一句话写明理由——防什么、或超在哪;原创只投在 cc-switch 架构上做不到的事(降级可观测、槽位路由、成本护栏)。
- 协议层与启动器零第三方依赖;`claude-hub.py` 依赖走 PEP 723 内联声明。
- 改协议层必须同步补测试。验证:`python3 -m unittest discover -s tests -p 'test_*.py'`。
- 仓库不留 TODO/FIXME 注释,缺陷要么修要么记 `docs/`。
- **新增、改名或归档 `docs/` 文件必须同步下面的索引**;`tests/test_docs_index.py` 双向守卫(漏索引与指向不存在的文件都判失败)。
- 待办只许住在 `work-queue.md` / `p0-tasks.md`。证据层文档里发现的未闭环项要打捞成卡,不能留在原文当藏身处。
- **证据层与参考矩阵文档首屏必须写「失效条件」**——一句话说清它什么时候可以归档或删除;写「永不归档」也算(排除项记录就该永久留)。缺这一行,`tests/test_docs_index.py` 判失败。没有失效条件的文档等于永生,这是 docs/ 只增不减的唯一原因。

## docs/ 索引

只列名字与用途,不转述内容(转述会过期)。**分组即状态**:组名说明该层的更新节奏和
读法,所以单个文件不标 ✅/过期——那种标记本身会过期。按文件名自取原文。

**宪法与设计**(几乎不变;动手前对照):

- `claude-hub-0.1-0.3-overview.md` — 0.1–0.3 路线总览、版本边界与统一交付门
- `claude-hub-0.1-task-pack.md` — 0.1 可安装、可调用、Companion 只读任务包
- `claude-hub-0.2-task-pack.md` — 0.2 Standalone 安全快速启动任务包
- `claude-hub-0.3-task-pack.md` — 0.3 发现、计划、批准与安全写入任务包
- `claude1-refactor-design.md` — 重构宪法
- `agent-hub-design.md` — Agent-Hub（Rust 管理面 + TUI/CLI + 编排式对话）决策树与架构
- `product-definition.md` — 产品定位与三档口径(现状/部分/待建)
- `codex1-design.md` — codex1 渠道启动器设计
- `context-window-design.md` — 上下文窗口判定与 1M 支持矩阵
- `transport-routing-design.md` — transport 路由与故障转移(阶段 A–D 已落地)
- `provider-snapshot-cache-design.md` — provider 快照热路径深化(已落地;`claude-hub.py` 的快照指标注释直接引用本文 §7 D5)
- `cc-switch-implementation-research.md` — cc-switch 实现调研;"继承优先于发明"这条硬约束的依据
- `维护与兼容指南.md` — 架构与维护约定

**队列**(每天变;**唯一的拿活来源**):

- `work-queue.md` — 跨战线主队列,从顶部拿活
- `p0-tasks.md` — 观测出口战线(work-queue S5)的细化队列

**参考矩阵**(随实现同步;改代码可能要一并改这里):

- `anthropic-protocol-implementation-status.md` — 协议能力矩阵与 disposition registry

**证据层**(只追加,永不重写;**结论已落地也不要删**——排除项的唯一记录在这里):

- `cache-diagnosis-2026-08-19.md` — 缓存失效根因、完整证据链与**已排除的 8 种可能**
- `error-attribution-diagnosis-2026-08-20.md` — 502/504 归因诊断
- `sse-truncation-fix-2026-08-26.md` — SSE 思考期断流两层修复全过程：根因证据链、
  客户端渲染实验账本、三副本部署拓扑、静默窗收紧依据；变更登记见 S19
- `claude1-protocol-baseline-2026-08-16.md` — 协议层只读基线与薄弱点
- `review-findings-2026-08-17.md` — 四路审查发现;R1–R6 已修,**剩余 R7/R8 已移交 work-queue S10,不要从本文拿活**

**runbook**:

- `publishing.md` — npm 发布

**素材目录**(非文档,不参与索引校验;各自的 README 说明用途):

- `design-references/` — UI 原型 HTML 与概念图
- `screenshots/` — 界面截图

**归档**(`docs/archive/`,不再维护,读之前先看该目录 README 的归档条件):

- `archive/handoff-cache-and-reliability-2026-08-19.md` — 缓存与可靠性交接;结论已并入 S1/S3,未闭环项已打捞进 S10
