# 工作队列：跨战线主队列

> 2026-08-19 建立。本文是**唯一的"下一件事"来源**，统管全部活跃战线。
> `p0-tasks.md` 降级为观测出口战线（S5）的细化队列，其"唯一合法来源"声明以本文为准。
>
> **队列规则**（继承 `p0-tasks.md`）
> - 从顶部未完成的卡拿活，一张卡 = 一次专注工作能闭环的单位。
> - 卡自带全部上下文：目的、依据、锚点、验收合同、明确不做。执行者不需要先读四份文档。
> - 做完一张：卡首行打 `✅ YYYY-MM-DD (commit)`，或直接删卡（git 归档）。不留"做了一半"的隐形状态——做一半的卡改写验收合同拆成两张。
> - 行号是 2026-08-19 快照，会漂移；以符号名为准。
> - 【现状】/【部分】/【待建】三档分明，不把待建写成现状。

## 为什么这样排（重排依据）

> **2026-09-08 本轮优先级**：用户明确要求先理解真实链路，再以可学习性为目标小步整理。
> 本轮从 S21 领取，不启动旧路线中的新功能；已有运行风险仍引用原卡，不重复登记。

`p0-tasks.md` 的队列假设是"观测出口优先"。2026-08-19 的两份实证把这个假设推翻了：

- **本机 255 条真实错误**（`~/.cc-switch/logs/claude-hub-errors.jsonl`，08-16 → 08-19）中，
  60% 是超时与断流：`504` 88 条（34.5%）、`ClientPayloadError` 断流 64 条（25%）。
  这些是**韧性**问题；T0.1–T0.6 全部做完，`504` 依然是 `504`。
- **缓存漏损已定量**：08-19 全天 86,665,644 输入 token 中 74,771,742（86.3%）按全价计费；
  根因已在代码层锁定（见 S1）。这是**当前唯一"根因已知 + 改动面小 + 收益可当场量化"**的项。

结论：观测出口（S5）仍要做，但它排在止损（S1）、消除风险（S2）和定性诊断（S3）之后。

## 已验证事实（不用重查）

- 缓存根因：`system` 提升把**逐轮 +1** 的 system 块追加到顶层 `system` 末尾，
  而顶层 `system` 位于上游缓存前缀最前端 → 每轮整个前缀重写。
  实况 `x47→x52`（全量日志 `x1→x85`），后果签名 `cr=0 / cw=46115` 且 cw 单调微增。
  完整证据链、已排除的 8 种可能、剂量-反应表见 `cache-diagnosis-2026-08-19.md`。
- 提升本身**幂等**、断点数量守恒、`cache_control` 未被丢弃——这三条已被探针证伪为原因。
- 提升原是为 SGLang 一类严格实现准备的（`anthropic-protocol-implementation-status.md:29`）；
  Claude Code 直连官方 API 时本来就直接发 `messages[].role == "system"`，官方接受。
- 断流 64 条**全部**是 `phase=stream` + `format=anthropic` + `model=claude-opus-5` + `channel=direct`。
- `504` 的日分布：08-16 = 0，08-17 = 67，08-18 = 0，08-19 = 22 —— 间歇性，不是恒定配置问题。
- `UI/` 两端都已实现（`macos/src` 11910 行 + Rust 4981；`windows/src` 11533 行 + Rust 5162），
  但已漂移：当前实测前端 28 个 + Rust 10 个文件内容不同（多为 DESIGN §5 平台白名单
  项与平台 FFI 分层，token 层已归零，见 S9/S4）。
- **现行 system 处理**：Hub 渠道默认 `passthrough`，仅显式 `native_system_role_mode: promote`
  的严格上游才保留提升。真实 Claude CLI 两轮验收：`cr=3840 / cw=0`，无
  `HUB_DEGRADE_SYSTEM_ROLE_PROMOTED`（S1 卡体已于 2026-08-21 压缩，原文见 git）。
- **已否决**：改变角色语义的 `demote` 猜测性修复。手工构造的「顶层断点 + 动态 system-role」
  两轮虽仍 `cr=0/cw=3075`，但手工重放历史 message-level 断点被上游 `400` 拒绝，
  **那不是 Claude Code 的真实 wire 形状**，不能作为改角色语义的依据。
- **已否决**：给 DeepSeek 一类模型继续加专属字段映射。某 OpenAI 兼容渠道的 DeepSeek 模型在约
  14K 字符长 system prompt 下出现乱码、重复 token、`finish_reason=length`——这是**模型语义/
  上下文承载失败，不是协议兼容问题**，加字段映射修不了。渠道与模型的真实名字属 CC Switch
  私密数据不入库（原 T0.0d 结论，卡已删，具体名字见 git 历史）。
- **操作前提**：要改 CC Switch DB 里的模型槽位必须先退出 cc-switch，否则被它的内存 store
  回写覆盖。
- 历史旧 bridge 的 usage 里仍有旧版本产生的 promotion warning：那是历史证据，
  不与新 Hub 运行态结论混算，也不做破坏性清理。
- `UI/` 有 15 处 `secret_guard` 命中，全在 `redact.rs` / `journal.rs` / `hubs.rs`，
  是脱敏函数的测试样本（非真实凭证）。

---

## S1 · 让逐轮增长的内容不再进入缓存前缀

**状态**：✅ 2026-08-19，真实运行态已验收。卡体已于 2026-08-21 压缩——根因、证据链与
已排除的 8 项见 `cache-diagnosis-2026-08-19.md`；现行配置与两条否决结论见上方
「已验证事实」；完整验收记录用 `git log -- docs/work-queue.md` 翻。

---

## S1b · 提升 warning 补上体积与断点信息

**目的**：当前 warning 只记 `first` path 与计数，看不出提升块的体积，也看不出是否携带
`cache_control`——这次诊断只能靠反推。补齐后下次缓存回归直接从日志读。

**做法**：把提升块总体积与"是否携带 `cache_control`"两项加进 `warning_details`。

**验收合同**：新字段落进 journal 且不含 payload 内容；有测试；全量绿。

**明确不做**：改提升行为本身（S1 负责）。

---

## S2 · `UI/` 纳入版本控制

**状态**：✅ 2026-08-26 (f9fc80a)。`UI/` 33k 行基线已入库（415 个文件被跟踪），
secret_guard 17 处命中全部处置（2 处真私有信息改写、其余误报标记），`.gitignore`
已排除构建产物。后续 UI 演进按行为级 commit 走正常版本控制；漂移对账归 S4。

---

## S3 · `504` 与断流定性诊断

**目的**：判断 88 条 `504` 和 64 条断流是**上游抖动**还是**本地超时/缓冲设置**。
不诊断就加重试，很可能只是把失败变慢、把重复计费变多。

**依据**：`504` 日分布 08-16=0 / 08-17=67 / 08-18=0 / 08-19=22；
断流 64 条全部 `phase=stream` + native + `claude-opus-5` + `direct`。

**做法**：产出一份像 `cache-diagnosis-2026-08-19.md` 那样带证据链的文档，至少回答：
1. `504` 是否与请求体量、会话时长、并发数相关？是否集中在特定时段？
2. 断流是否集中在长响应？`ClientPayloadError` 发生时已收到多少字节？
3. 本地 transport 的超时配置（`claude1_transport.py`）与观测到的失败时刻是否吻合？
4. 结论必须落到"上游"或"本地"，或明确写出无法分离及其原因。

**验收合同**：文档含数据来源、方法、反面证据与置信度；结论支撑下一张卡的开卡条件。

**明确不做**：写重试、改超时、加熔断——等诊断结论出来再开卡。

---

## S4 · macos / windows 漂移对账

**前置**：S2（不入库就没有可靠 diff 基线）

**目的**：当前实测前端 28 个 + Rust 10 个差异文件（S9 追平后余量）里，分清
**平台必要差异**
（圆角、字体、动效时长、亚克力层、路径处理——`UI/README.md` 明说两端可以偏离）
与**漏同步的修复**。

**做法**：逐文件对账，产出表：文件 | 差异性质（平台必要 / 漏同步 / 待判定）| 处理动作。

**验收合同**：表覆盖全部差异文件（以对账当时的 `diff -rq` 实测为准，不沿用历史数字）；"漏同步"项各有对应修复卡或直接修掉；
"平台必要"项在 `UI/DESIGN.md` 有依据。

**明确不做**：把两端强行统一——分目录本身就是为了允许偏离。

---

## S5 · 观测出口（原 P0 队列）

**细化队列**：`p0-tasks.md`。当前状态：T0.0a ✅、T0.0b ✅、T0.0c 未完成、
T0.0d ⚠️（Nebius 语义不兼容，已结论）  <!-- secret-guard: allow private-provider-name 97985df2c2（公开推理平台名，历史记录） -->、T0.0e ✅；**T0.1–T0.6 全部未开始**。

**为什么排在这里**：它的 DoD（"任意一次降级发生后能在 errors/usage 查到"）是对的，
且是协议层宽容化的前置。但它不解决当前 60% 的失败（超时与断流），
也不解决 token 漏损，所以让位给 S1–S3。

**开卡条件**：S1 完成且 S3 有结论后，从 `p0-tasks.md` 顶部拿 T0.1。

---

## S6 · codex 战线扩展（推后）

**现状**：`codex1` 已落地可用（影子 `CODEX_HOME` + profile 层叠 + 影子 `auth.json`，
设计见 `codex1-design.md`），它**不是** hub：没有网关、协议转换、账号池、failover。

**为什么推后**：扩展它是开新战线，而 claude-hub 仍在漏 token、仍有 60% 的失败未定性。

**开卡条件**：S1、S2、S3 全部闭环。届时先写一张"要不要给 codex 做 hub"的决策卡，
而不是直接动手——`codex1` 当前的"随开随用"定位可能本就不需要网关。

---

## S7 · 待定义战线

**状态**：【待建】。2026-08-19 口述中提到但转写丢失，需要口径澄清后补卡。

补卡时至少写清：它是什么（CLI / 产品 / 能力）、与 claude1 现有边界的关系、
是否需要协议桥、开卡条件。**在定义清楚之前不占用 S1–S3 的时间。**

## S8 · 上下文窗口自动判定

**状态**：✅ 2026-08-20。`claude1_context_window.py` + `tools/extract_1m_matrix.py` +
`doctor [--probe]` + `tests/test_context_window.py` 38 项，设计见 `context-window-design.md`。
卡体已于 2026-08-21 压缩；**体检发现的存量问题已拆为 S11**。

---

## S9 · Windows 端同步 2026-08-20 视觉翻新

**状态**：✅ 2026-08-26 (9c99c8a, e3f500a, f063175)。token-parity 归零（49→0）、
壳层（十视图路由/三组侧栏/Ctrl 系快捷键/toast/命令面板）与十视图已全部追平，
`windows/src/store/ui.ts` 已存在，`--text-tertiary` 等关键 token 与 DESIGN 一致。
余下的两侧文件差异（前端 27 + Rust 9，多为 DESIGN §5 平台白名单项与平台 FFI 分层）
归 S4 对账口径管理。

---

## S10 · 打捞藏在证据层文档里的隐形待办

**状态**：【待建】。2026-08-21 清理 `docs/` 时发现四条待办压在证据层文档里、
不在本队列中，违反本文"唯一的'下一件事'来源"。本卡只负责**拆卡**，不负责实现。

**依据**（四条已逐个核实，非转述）：

1. **`bytes_received` / `request_bytes` 仍不存在** —— `elapsed_ms` 已落地
   （`claude-hub.py` `record_error`/`record_usage` 签名，另见 `:2951` `:3101` 埋点），
   但字节计数没有。**S3 做法第 2 问**"`ClientPayloadError` 发生时已收到多少字节"
   用现有字段答不了 → 这是 **S3 的阻塞项**，不是独立优化。
2. **`TransportUnavailable` 37 条从未调查** —— 占比 14.5% 排第二，33 条压在 08-18 一天；
   全队列（本文 + `p0-tasks.md`）grep 无此卡。
3. **`review-findings-2026-08-17.md` R7 测试欠账未清** —— 该文自述"第 4 项已闭环、
   第 6 项部分推进"，其余未动。
4. **同文 R8 文档与清理 8 项未动** —— 含 3 处免责措辞需从"无专属 Hub E2E 测试"
   下调为"全无测试覆盖，仅源码路径"。
5. **`claude1-protocol-baseline-2026-08-16.md` §6 十个薄弱点从未对账** —— 已知 #4 由 T0.0b、
   #6 由 T0.0a 修掉，#5 对应 T0.0c 未完成，**其余七项状态未核**。这张表真假混杂，
   按它判断现状会得出错结论。
6. **额度面抢占未解决**（原 `tracer-bullet-audit.md` 阶段 3，该文已于 2026-08-21 删除，
   内容在此内联）：控制面抢占已解决（claude1 不切 CC Switch current），但账号池 state
   **没有 in-flight lease、owner 或外部会话观测**，CC Switch 自己发起的请求也不登记到
   claude1。拆卡前先做产品选择：每账号 `max_concurrency` + lease TTL（只约束自己可见的
   请求）／native 会话登记长 lease 并在退出释放、崩溃由 TTL 回收／**不默认独占 key**
   （避免长会话占着但无请求时白降吞吐）。前提写明：无法强制协调未接入本 state 的客户端。
7. **账号池可观测性欠账**（原阶段 4，同上内联）：`accounts list` 缺最近状态码、冷却截止、
   脱敏的最近选择时间；`claude1 usage` 未按 account 聚合（JSONL 里已有 `account` 字段）；
   auth-disabled／cooldown／orphan／incompatible 四种情况该给不同修复动作；若继续支持
   `weighted`，评估 smooth weighted round-robin 以免大权重形成连续请求突刺。
   **明确不做**：CLI 稳定前不把账号池编辑逻辑复制进多个 Channels/Slots 页面。
8. **`anthropic-protocol-implementation-status.md` 混层** —— 活的能力矩阵与过期的阶段 0
   基线快照（`339/339`，现为 `796`）混在一份里。拆掉快照段落即可升为常驻参考矩阵。

**锚点**：`record_error` / `record_usage`（`claude-hub.py`，以符号名为准）、
`claude1_transport.py` 的超时与异常路径；`review-findings-2026-08-17.md` R7/R8 两节。

**验收合同**：八条各自成为本队列的独立卡，或被明确判定为不做并写明理由；
拆完即删本卡。每份被打捞的证据层文档顶部都要留一行指向新卡编号（`review-findings`、
`claude1-protocol-baseline` 两份已于 2026-08-21 加好；`tracer-bullet-audit` 同日删除，
阶段 3、4 已内联为上面第 6、7 条），
让证据层文档不再是待办的藏身处。

**2026-08-21 变更**：`degrade-inventory.md` 已按用户决定删除（原第 7 条「脚本化」因此
作废）。代价是那 37 个 code 的四列人工判断（触发条件／冒泡载体／Hub 出口／证据）只存于
git 历史。受影响的 `p0-tasks.md` T0.5、T0.6 已改写为**从代码直接盘点**——
`rg -o 'HUB_DEGRADE_[A-Z0-9_]+' claude1_protocol.py | sort -u`，比对照一张已脱节 6 处的
旧表更可靠。要翻回四列判断：`git log --diff-filter=D -- docs/degrade-inventory.md` 定位删除提交，取其父版本。

**明确不做**：不在本卡内实现任何一条。第 1 条的埋点位置留给拆出去的卡决定，
且必须先确认字节计数不把 payload 内容带进 journal（硬约束）。

---

## S12 · 首字节前断流对客户端静默重放

**状态**：✅ 2026-08-22 仓库实现（`4e48481`）；✅ 2026-08-23 已移植到运行态副本
`~/.claude/scripts/claude-hub.py`（备份 `claude-hub.py.bak-20260823-073819`，回滚即恢复该文件）。
运行态副本上 `tests/test_claude_hub.py` + `tests/test_routes.py` 共 256 条通过；
hub 随 launcher 起，所以只有**新起的会话**吃到修复，已在跑的会话不受影响。

**目的**：让上游网关的 120s **静默期**闸门不再吃掉整个回合。闸门在模型还在排队时触发，
断点几乎全在真实内容之前——`output_tokens=2` 的空回合占实测 11 次断流中的 6 次。

**根因（S3 诊断的延伸）**：`_forward_to_channel` 过去在读第一个上游 chunk **之前**就
`await response.prepare(request)`，于是只值 202B 的 `message_start` 就把下游提交掉，
本来安全可重放的失败被钉成终局。Claude Code 侧无解：流重试上限 `Wr=1` / `Co=2` 硬编码，
且以「尚未提交」为前提，没有环境变量能改。

**做法**：`_DeferredDownstream`（`claude-hub.py`，紧邻 `_SSETerminalTracker`）把流式响应
扣在手里，直到 `_SSETerminalTracker.content_started` 证明上游真的在产出
（`message_start` / `ping` 只算元数据）；`_forward_to_channel` 变成薄重放壳，
把 `UpstreamStreamReplayable` 重放最多 `STREAM_REPLAY_ATTEMPTS`(2) 次，
缓冲上限 `STREAM_REPLAY_BUFFER_BYTES`(256 KiB) —— 超限就提交，宁可放弃重放也不丢字节、不无界增长。

**没做伪装**：重放耗尽仍旧 abort 传输；干净 EOF 缺 terminal 事件走原路（那是上游自己的畸形
答复，重放只会复现），每次失败的尝试照旧各写一行 `phase=stream` 错误账，方便事后数「吃掉了几次」。

**验收合同（已满足）**：`python3 -m unittest discover -s tests -p 'test_*.py'` 805 通过，
含 3 条新测试——真实 loopback 双连接静默重放、重放预算耗尽后照旧 abort、
元数据前奏超过缓冲上限即提交；函数长度棘轮双维度不退步（`_forward_to_channel_attempt` 451 < 467）。

**明确不做**：`_handle_transformed_messages`（openai_chat 转译路径）未改；把 `504` 加入
`ROUTE_FAILOVER_STATUSES` 仍是独立一卡（见 `error-attribution-diagnosis-2026-08-20.md`「未开的卡」）。

---

## S13 · 运行态副本与仓库双向分叉，`install.sh` 当前是破坏性的

**目的**：把 `~/.claude/scripts/claude-hub.py` 上只存在于运行态的功能收回仓库，
恢复「仓库是唯一真相」，让 `install.sh` 重新可用。

**依据**（2026-08-23 实测）：两边各有对方没有的东西。

| 只在运行态副本 | 只在仓库 |
| --- | --- |
| `signature_guard` 渠道开关 + 配置校验 | `_TurnJournal` 单回合日志身份（`40a503f` / `31e99c1`） |
| `_signature_guard_sanitize_history` + 一次性无 thinking 重放 | |
| `CLAUDE_HUB_PARENT_WATCH` / `CLAUDE_HUB_PARENT_PID` + `ParentGone` | |

**风险（先读这条）**：`install.sh` 的 `needs_install` 是 `cmp` 后直接覆盖，
**现在跑它会把运行态的 `signature_guard` 与 parent-watch 抹掉**。对账完成前不要跑。

**做法**：把上表左列逐项搬回仓库并补测试（`signature_guard` 的分支要有真实 400 fixture），
然后跑一次 `install.sh` 让两边逐字一致。S12 的 stall 重放两边都已有，不必再搬。

**验收合同**：`cmp -s claude-hub.py ~/.claude/scripts/claude-hub.py` 静默通过，
且 `python3 -m unittest discover -s tests -p 'test_*.py'` 全绿。

**明确不做**：反向覆盖——把仓库版直接装过去等于删功能。

---

## S11 · 修掉假 1M 模型槽位

**状态**：【待建】。2026-08-20 `claude1 doctor --probe` 体检发现、按指派只报告未修
（原 S8 卡体，S8 已于 2026-08-21 压缩）。

**依据**：**5 个 provider 共 14 个模型槽位是假 1M**，另有 1 个 provider 的
`claude-opus-5[1M]` 是多余后缀。窗口被高估比低估更糟——客户端不再压缩，改由上游回
`400 prompt is too long`（见 `context-window-design.md`）。

**做法**：两条修法择一——声明 `claude1_capabilities.context_window`，或去掉后缀让 CLI
用注册表窗口。**前提**：动 DB 行前必须先退出 cc-switch，否则被它的内存 store 回写覆盖。

**验收合同**：`claude1 doctor --probe` 对这 15 处不再报假 1M；改动前后各存一份体检输出。

**明确不做**：`modelOverrides` + managed settings 路径（需系统级写入，且 `Hgo` 会在
host-managed 场景删除该键）；启动路径发探测请求。

---

## S14 · Agent-Hub：Rust 管理面（TUI + CLI + 编排式对话）

**状态**：✅ M1 代码 checkpoint（`0841520`）；继续 M2 前仍需手动打开真实 TUI 列表验收。
2026-08-24 决策树 Q1–Q11 已定稿（`agent-hub-design.md`），
四路调研完成（cc-switch-cli / All API Hub / ai-switch 家族 / T3 Code），
参考实现已浅克隆至 `~/Documents/Codex/2026-06-07/cc-switch-cli`。

**目的**：claude1 菜单审美疲劳且渠道增多后难维护；Agent-Hub 用 Rust 重写管理面
（TUI+CLI 双模式），共享 cc-switch DB，协议桥留 Python 不动。

**M1 卡 · 只读闭环**：workspace scaffold（根 `Cargo.toml` + `crates/agent-hub`），
`agent-hub provider list/current`（CLI）与裸命令 TUI 渠道列表页，全部只读。
DB 打开用 `SQLITE_OPEN_READ_ONLY`；`user_version` 高于 cc-switch-cli 的 17 时拒绝并提示
（本机实测 16）；`settings_config` 含凭证，list 输出永不打印。

**验收合同**：`cargo build` 通过；`agent-hub provider list` 输出与 `cc-switch.db` `providers` 表等量的渠道数（数字会漂，以 DB 实测为准；2026-08-28 为 35）且不含任何
key 材料；裸命令 TUI 列表可 j/k 导航、q 退出；`python3 -m unittest discover -s tests -p 'test_*.py'`
不退步（`test_docs_index.py` 含新设计文档索引行）。

**明确不做**：写路径（切换/快照/回滚）是 M2；MCP/prompts 后置（Q10）；
proxy/daemon/webdav 不抄（Python hub 已有协议层）；GUI 不动（M5 才接 `UI/`）。

## S15 · gateway transform 路径的三个语义缺口

**状态**：【实验实现，未形成仓库 checkpoint】。2026-08-25 在尚未跟踪的 `gateway/`
实验目录中处理了两条真实故障，剩余三条仍未闭环；在该目录的产品归属、测试与提交边界
明确前，不把它们记作主线已修。来源：审查 session `83d64860` 的 M2 落地成果，从
`.workbuddy-ai/memory/`（已删除的临时 workspace）打捞。

**实验目录中已实现（2026-08-25，未提交）**：
- `instructions` 曾把 Anthropic 的 `system` 数组原样转发，上游报
  `instructions: invalid type: sequence, expected a string`（真实上游控制台错误）。
  实验实现由 `flattenSystemToInstructions` 拼成单字符串。
- `tool_use` / `tool_result` 曾被静默 drop 后照发 `end_turn` + `message_stop`，
  违反 CLAUDE.md「工具调用丢了不伪装 completed」。现返回 400 显式拒绝
  （`unsupportedBlockError`）；实验实现对 `image` 等有损块放行并记
  `HUB_DEGRADE_TRANSFORM_BLOCK_DROPPED`。

**目的**：把上面那个 400 拒绝换成真支持，并补齐 thinking 保真。当前状态是"诚实但不可用"
——真实 Claude Code 首个请求即带 tools 并进入 tool_use 循环，所以 transform 模式
目前对 Claude Code 客户端实际不可用，只能跑无工具单轮。

**锚点与依据**：
- tools 定义已在转发（`internal/proxy/proxy.go` 的 `anthropicTool`），但
  `internal/adapter/openairesponses/` 里 `grep 'tool\|function'` 零命中 ——
  上游回工具调用网关不认。双向都缺。
- signature 链条是断的：adapter 里 `grep signature` 零命中，而
  `internal/renderer/anthropic/anthropic.go` 有 `signature_delta` 输出能力 →
  transform 路径产出的 thinking block 永远无 signature → 多轮回传 thinking 时上游 400。
- renderer 有 10+ 处 `json.Marshal`，所以 canonical 三层必然 re-serialize；
  thinking/signature 要走字节保真通道而不是经过 canonical 结构体
  （对照 CLIProxyAPI #2172）。

**验收合同**：transform 模式下真实 Claude Code（干净环境、不设 `HTTP_PROXY`）能完成
一次带工具调用的多轮任务；thinking 回传不触发 400；`go test ./...` 不退步。

**明确不做**：Chat Completions adapter（M3 另立）；非流式 buffering。

## S16 · 19 条渠道盘点：10 条静默失效，全是小修复

**状态**：【待建】。分类结果出自 session `83d64860` 的实测，**本卡未复跑**，执行前先重验。

**目的**：可用容量被系统性高估。实测 19 条渠道 = 7 健康 / 10 失效 / 2 待确认，
10 条失效原因各不相同且全部是小修复能救的（欠费充值、`base_url` 改一行、换 key、改 filter）。
修渠道的成本远低于把 gateway 做成完整协议转换网关，收益是立即拿回容量。

**结构性发现**：一个私有上游域名下挂 5 条 provider 记录（两组 alias），是同一故障域被
计成 5 条独立渠道 —— 所以"渠道多所以总有能用的"这个直觉不成立。真实名称只保留在
CC Switch 私有数据与本机诊断记录中，不进入仓库。

**两条判据纪律**（本轮审查确认，重验时必须遵守）：
- 协议缺陷是 **(渠道 × 模型) 二维**的，不是渠道单维属性；按渠道整体判好坏会同时误杀
  可用组合、漏掉坏组合。
- 健康检查**必须看 `Content-Type`**：阿里云 WAF 挑战页返回 HTTP 200 + `text/html`，
  只看状态码的探测会把被拦渠道报成健康。

**验收合同**：产出一张 (渠道 × 模型) 矩阵，每格标状态 + 判据来源；10 条失效逐条给出
修复动作与成本；同故障域合并计数后给出真实可用容量数。

**明确不做**：不在本卡里改 gateway 代码；不碰凭证明文（只读 cc-switch DB，输出永不含 key）。

## S17 · 渠道无 transport 配置时默认直连导致上游 451（应默认感知代理）

**状态**：【代码完成，运行态未验证】（`7818ae2`）。2026-08-25 实测定位；2026-08-26
完成修复与自动化验证。GitHub issue: Aley3567/Agent-Hub#117。

**目的**：用户开着本地代理，新增一个未配置 transport 的渠道后，claude1 每个请求都被
其上游以 451「当前网络请求已被拒绝」拒绝。原因不是上游坏，而是两个缺省
行为叠加：launcher 会为没配 transport 的渠道把 API host 塞进 `NO_PROXY`；当前隔离 Hub
虽然仍能从系统配置发现 direct + proxy 候选，却只在直连返回 403 时换 transport，451 会被
立即提交给客户端。设计缺陷：自动路由既残留了强制直连改写，也漏掉了明确的网络策略拒绝，
最终还裸抛 451，没有任何「可能需要代理」的提示。

**依据**：
- 实测证据链：直连受影响上游返回 451 HTML 拒绝页；走本地代理时，同一请求对两个模型
  都返回 200，且 stream+tools 完整请求通过。真实渠道、域名、模型与代理地址只保留在
  CC Switch 私有数据和本机错误日志中，不进入仓库。
- 对照成功渠道显式配置了 `settings_config.transport = {"mode": "proxy", "proxies": [...]}`。
- 代码锚点：`claude-provider-once.py` transport 解析（无 `transport` → `auto`）与
  `build_settings()` 的 `NO_PROXY` 注入；`claude-hub.py::_post_with_account_failover()` 原本只对
  403 设置 `retry_response`。2026-08-26 在桥进程等价的干净环境中解析真实 endpoint，候选为
  `[direct, proxy:<local-proxy>]`，证明当前 451 实况的直接阻断点是重试分类，不是候选发现。

**做法**（择一或组合，先出最小改法）：
1. 无 `transport` 配置时不再把 host 塞进 `NO_PROXY`，让系统代理（`HTTP(S)_PROXY`）自然生效；
   `auto` 模式保持 direct + proxy 双候选。
2. 或提供全局默认 transport（如 `CLAUDE1_TRANSPORT_PROXY`），渠道无配置时继承。
3. 直连被 451 / 网络层拒绝时，错误层给出可操作提示：「该渠道可能需要代理，请在渠道配置
   transport」，不伪装成功。

**验收合同**：新渠道（无 transport 配置）在开着本地代理的环境下请求受影响上游不再 451；
错误日志对「可能需要代理」的渠道给出可操作提示；`python3 -m unittest discover -s tests -p 'test_*.py'`
全绿，新增针对 transport 缺省行为的测试。

**明确不做**：不改受影响上游的行为；不给所有渠道强制走代理（部分渠道必须直连）；
不在本卡动协议层。

**实现记录（2026-08-26）**：缺省/auto 渠道不再由 launcher 把 API host 注入
`NO_PROXY`，显式 `direct` 仍隔离系统代理；Hub 将上游 `451` 与 `403` 同样视为可安全换
transport 的明确拒绝，在同账号内先尝试下一个候选。所有候选最终仍返回 `451` 时，客户端
错误与持久错误日志附带 transport 配置提示。新增缺省 `NO_PROXY`、显式 direct、
direct-451→proxy-200、最终 451 提示四组回归测试；全套 820 项测试通过。尚未发送真实凭证
请求，受影响上游的真实 Claude Code 会话验收保留。

## S18 · openai_responses 转换对上游新形态 fail-closed 成 502「incompatible response」

**状态**：【待建】。2026-08-25 实测定位，连续 8+ 次实况。 GitHub issue: Aley3567/Agent-Hub#118。

**目的**：`502 hub: channel 'direct' returned an incompatible openai_responses response`
长期反复出现，客户端只看到误导性文案无法自救。根因是 openai_responses 输出转换层对
上游新字段/新形态系统性 fail-closed：今天 17:31 起连续 8+ 次
`code=HUB_UPSTREAM_OUTPUT_BLOCK_UNSUPPORTED` 卡在 `$.output[0].phase`，每次先等 4–24s
才整单 502。违反 CLAUDE.md「默认放行，例外才拒」总原则——不认识的 output block/phase
应走 `HUB_DEGRADE_*` 有损放行，而不是把整个渠道打成不可用。

**依据**：
- 错误模板：`claude-hub.py:3378` 把 `ProtocolTransformError` 统一转 502 +
  `hub: channel '{alias}' returned an incompatible {api_format} response`，丢弃 code/path。
- 拒绝点：`claude1_protocol.py` 中 `HUB_UPSTREAM_OUTPUT_BLOCK_UNSUPPORTED` 共 15+ 处，
  覆盖多种上游 output block 形态（含 `$.output[0].phase` 等）。
- 实况：`~/.cc-switch/logs/claude-hub-errors.jsonl` 2026-08-25 17:31+ 连续 8 条
  `format=openai_responses` + `status=502`，`model=deepseek-v4-flash`，`channel=direct`，
  `ms=4.3–23.9s`。
- 长期性：openai_chat 路径同类（2026-08-23 grok-4.5 `HUB_UPSTREAM_USAGE_INVALID
  $.usage.total_tokens`）——转换层对上游新形态是系统性 fail-closed，不是单个模型问题。

**做法**（先出最小改法）：
1. openai_responses 输出转换按「能无损转就转 / 有损放行记 HUB_DEGRADE_* / 只有安全因果才拒」
   三档重审全部 `HUB_UPSTREAM_OUTPUT_BLOCK_UNSUPPORTED` 拒绝点；未知 phase/block 形态
   放行并记录降级码。
2. 必须拒的场景，客户端错误文案带上 `code@path`（如
   `HUB_UPSTREAM_OUTPUT_BLOCK_UNSUPPORTED@$.output[0].phase`），不伪装成笼统 incompatible。

**验收合同**：`deepseek-v4-flash`（openai_responses 直连）在真实会话中不再整单 502；
不认识的 output 形态在 errors/usage 里留下 `HUB_DEGRADE_*` 痕迹且响应可用；
`python3 -m unittest discover -s tests -p 'test_*.py'` 全绿，新增未知 phase/block 放行测试。

**明确不做**：不改上游（OpenAI Responses spec 方言归上游）；不在本卡动凭证与鉴权。

## S19 · 某中转网关思考期断流静默重放（glm-5.3「首条消息空回 + mid-response」）

**状态**：【代码完成，合成上游运行态已验证；真实上游待自然复发验证】。2026-08-26 定位并实现。
行为一（具名终局）独立提交 `477a0b4`；行为二（思考期扣留重放）见实现记录。
2026-08-26 已部署：cherry-pick 进个人版分支（`f4614bc`/`6a33e49`，840 测试绿）并热替换
本机运行副本（备份 `claude-hub.py.bak-s19replay-20260826-171457`）；合成 flaky 上游端到端
A/B/C 验收通过（静默重放 / 真客户端零感知 exit 0 / 正文期失败仍可见）。
渠道与域名属 CC Switch 私有数据，不入仓库；本机证据见 `~/.cc-switch/logs/claude-hub-errors.jsonl`。

**症状与根因**：该 newapi 网关家族间歇性把 SSE 流干净关闭
且不发任何终态事件。journal 61 条 `IncompleteSSE` 跨 opus/gpt-5.6-sol/deepseek/glm-5.3
全部集中于该家族；2026-08-26 13:46–13:48 glm-5.3 两条实况（2.7s/18.4s）全部死在
thinking_delta、正文零字节 → 客户端 Ctrl+O 可见思维链但回复为空并报
「Connection lost mid-response」。实况抓包证实上游 EOF 无终态；h1.1 各变体对照实验
（小/大/gzip/真 CC）同时段全通过 → 截断是**间歇性**而非确定性，推翻了 S12 时代
「干净 EOF 重放只会复现」的前提——该前提仅在正文已可见后依然成立。

**做法（两层）**：
1. 已提交后的截断：以具名 `event:error`（api_error，保留「mid-response」措辞供续接钩子）
   收尾，不再裸 abort——失败仍可见，但可渲染、可 hook。
2. 提交前：tracker 新增 `commit_started` 分类（message_start/ping/thinking 系列扣留，
   其余一律视为正文放行）；native 流扣留上限 `THINKING_HOLD_BUFFER_BYTES`=1MiB、
   保护窗 `THINKING_HOLD_MAX_SECONDS`=45s（2026-08-26 晚由 120s 收紧：实测上游截断
   全部发生在思考早期 2.7s/18.4s，且真 CC 对 75s 纯静默耐受无恙——缩窗把最坏静默
   体感封顶，覆盖面几乎无损）；窗内干净 EOF 且下游零字节 →
   `UpstreamStreamReplayable` 静默重放（预算沿用 `STREAM_REPLAY_ATTEMPTS`），每次尝试记
   `HUB_DEGRADE_STREAM_REPLAYED`；超限降级到第 1 层。放弃的备选：SSE 哑心跳需要提前
   prepare 下游，与 route failover 的跨目标重放冲突，记录备查。

**客户端渲染实测（CC 2.1.229 `-p`，选型依据）**：流中 `event:error` 被渲染为误导性的
「empty or malformed response」并自动重试一次；裸 RST 渲染为 mid-response 报错；
**干净 EOF 无终态 = 静默空回 exit 0（数据丢失不可见，最劣）**。故失败必须保持可见，
第 2 层的目标是让它根本走不到客户端。

**验收合同**：新增 4 条回归测试（静默重放 / 预算耗尽 504 / 字节上限降级 / 时间窗降级）；
全套 906 测试绿；真 CC + 真桥 + 合成 flaky 上游端到端：首试截断被重放吃掉，CC exit 0
零感知。真实上游运行态由自然复发时 errors.jsonl 的 `deg` 码与消失的 mid-response
用户报告验证。

**明确不做**：不伪造 `message_stop`；不对已见字节的回合重放；不动 transform 路径
（openai_chat 同类截断另行开卡）；不换 h2 客户端（实测该网关 h2 在 ~64KB 处截断，
aiohttp h1.1 不受影响）。
- 2026-08-26 UI 契约扩展 chat/plugins/tasks 三视图，实施中。

## S20 · 下游失活被误判为上游中断：死客户端触发全量重放与错误归因

**状态**：【待建】。2026-08-26 code-review（3a4d81f/4662665 审查）发现。问题预先存在，
卡 3 的收口触及并重新验证了该分支；结构已核实（异常链与分类条件逐行读过），未做运行态复现。

**问题**：客户端在下游尚未启动时断连（典型：思考扣留窗内客户端离开），首次真实内容
flush 调用 `downstream.open()` → `response.prepare()` 抛 `ClientError/OSError`。该异常被
`_forward_to_channel_attempt` 流循环的广义 except 捕获，与上游传输中断走同一入口
`_resolve_broken_native_stream`；其中「not downstream.started + TRANSPORT_BROKEN_ERRORS」
的分类使其被当成上游在正文开始前停滞 → 完整请求按 `STREAM_REPLAY_ATTEMPTS`(=2) 重放，
但客户端已死，重放必然再失败并以 504/bare abort 收场；每条 journal 把失败归因于
渠道/账户（upstream broke）而非丢失的客户端。

**对照**：`_write_truncated_native_terminal` 已显式区分下游写失败（abort transport +
`UpstreamStreamAborted("downstream closed while reporting ...")`）；缺口只在
`_resolve_broken_native_stream` 的分类条件没有同等的下游来源判定。

**修法方向**：分类前先区分异常来源——把 `_DeferredDownstream.open()/write()` 内的下游侧
连接失败转成带标记的专用异常（或等价机制），使 `_resolve_broken_native_stream`
直接 raise `UpstreamStreamAborted` 并让 journal 记可辨识的归因，不进入重放臂。

**验收合同**：新增测试——客户端首字前断开（模拟下游 open 抛 ClientError）：上游
session.calls == 1（不重放）、journal 行可辨识为下游失活、无重试延迟；全套测试保持绿。

**明确不做**：不改上游传输类异常的重放语义；不动 thinking-hold 扣留窗口；
不为下游失活造新的用户可见响应（客户端已不在）。

---

## S21 · 面向学习与求职展示的渐进整理

**当前状态**：计划已整理，尚未启动以下六个计划。2026-09-08 用户要求先保存计划，稍后逐项分析和操作。
**目标**：保持 Model / Protocol Gateway 定位，让请求链容易追踪、职责单一、行为可验证。
**代码基线**：`3f45b6a`；事实与调用链见 [request-flow.md](request-flow.md)。执行前以当前符号重新核对，行号不作为合同。

### 已完成的检查点

| 检查点 | 本地提交 | 已有证据 |
| --- | --- | --- |
| 请求链路导读、README 边界与初步方案 | `74f78a1` | 文档索引 6 项通过，修改前 Python 全量 959 项通过 |
| npm 产物缺 context_window 模块修复 | `b27412c` | 真实 tarball 修复前启动失败、修复后通过；全量 961 项通过 |
| 模型路由独立、显式传入 provider 快照 | `3f45b6a` | 全量 967 项、安装 6 项通过；新旧路由 1,248 组对照一致 |

以上是历史检查点，不因计划重排而重新执行。尚未部署本地修改至用户运行目录，不能当作真实上游验收。

### 六个计划与执行顺序

| 编号 | 唯一主题 | 完成后更清楚的事情 | 前置条件 |
| --- | --- | --- | --- |
| [S21-P1](#s21-p1) | 主链转换入口收敛 | 目标和账号池由谁准备 | 已完成纯路由提取 |
| [S21-P2](#s21-p2) | 协议错误模块与无状态转交 | 错误规则在哪里，转换调用经过几层 | 建议 P1 后执行；自身不依赖 P1 的代码 |
| [S21-P3](#s21-p3) | 配置读取与解释分离 | 谁读文件/环境/DB，谁解释配置 | 先完成 P1，重新核对配置与鉴权时序 |
| [S21-P4](#s21-p4) | Provider 快照状态集中 | 谁拥有缓存、锁、刷新与指标 | P3 的读库责任已明确 |
| [S21-P5](#s21-p5) | 启动器显示与操作分离 | 哪些代码只画界面，哪些执行操作 | 可独立分析；建议 P4 后实施 |
| [S21-P6](#s21-p6) | 请求编码与响应规则整理 | 请求如何转换，JSON/SSE 共用什么规则 | P2 已完成，共享依赖已重新核实；涉及流交付时先处理 S20 |

**默认逐个推进 P1 → P2 → P3 → P4 → P5 → P6，不并行修改同一主文件。**
“分析 S21-Pn”只产出该计划的调用关系、修改清单和验证合同；“执行 S21-Pn”先核对再执行一个
可独立提交的步骤。一个步骤闭环后报告结果并停止，不自动串行执行后续计划。

### 所有计划共用的边界

- **范围**：根 Python 主运行时与必要的 tests、npm/install 清单、调用链文档。先在现有安装结构中拆责任；不提前整库搬到 src。
- **行为**：默认保持 HTTP、CLI、协议与持久配置行为。内部函数参数/测试注入点可以明确迁移，不用兼容 wrapper 隐藏依赖；对外行为改变另立卡并单独验证。
- **保护**：工具调用关联、凭证处理、流终态、资源上限和 usage 来源保持。只有证明重复校验已由明确入口覆盖，才删除内部重复判断；不按 if 数量判定过度防御。
- **排除**：不扩建 Harness；不改 Rust/桌面 UI/Go 实验/Standalone 产品线；不增加 DI、自动注册、深继承或通用 Factory；不顺手修无关运行故障。
- **每步产物**：原问题、调用前后变化、文件/符号清单、行为是否改变、验证证据、未解决项，以及一个隔离的本地提交。旧 wrapper/别名删除前查仓库引用、测试与安装入口。
- **验证**：先跑直接相关测试；行为改动补能证明缺口的回归。代码步骤收口时运行 `python3 -m unittest discover -s tests -p 'test_*.py'`。新增/迁移运行模块必须同步 npm 与 install 清单，验证 `test_npm_packaging.py` 和 `tests/test_install.zsh`；更新导读后检查文档索引。保持导出名称/导入绑定可以直接 import 重导出，不增加只转交调用的函数。
- **停止条件**：需要未计划的反向 import、大批回调、新配置格式或无法隔离的行为变化时，先缩小切片并说明，不继续扩大施工。用户运行环境未验时只报告代码与隔离测试结果。
- **发布边界**：不安装到用户真实目录，不修改真实渠道/密钥/DB，不推送、不发布；已有 `.agents/` 工作不纳入提交。

<a id="s21-p1"></a>

### 计划 1 · 主链转换入口收敛

**状态**：待分析/执行。**建议粒度**：一个提交。

**现有问题**：`claude-hub.py::_handle_transformed_messages()` 同时接收 `target` 与其中已有的
`provider/alias/model_in/model_out`，还允许缺 target 或 account_pool 时内部重建。唯一生产调用
`_forward_to_channel_attempt()` 已经准备好两者，七处直接测试调用使用另一套准备路径。

**本计划只做**：要求 target、account_pool 为显式输入；删除四个重复参数与内部重建分支；
同步生产调用和直接测试。保留 `ChannelTarget` 的现有职责，不引入新的 RequestContext 或 service。

**预期调用**：`_forward_to_channel_attempt` 准备目标与账号池 → `_handle_transformed_messages`
转换/发送/返回。该函数不再兼任依赖准备者。

**明确不做**：不拆文件；不改请求编码、超时、账号选择、retry/fallback、SSE 提交时机或错误映射。

**验收**：检查实际发送的 URL/模型/凭证来源与调用次数；JSON/SSE、转换拒绝、错误归因及用量
场景保持一致。复用 `test_claude_hub.py`、`test_routes.py` 的合同；内部参数变化在导读中说明。
**停止点**：入口只有一套准备路径，相关与全量检查通过，独立提交后结束 P1。

<a id="s21-p2"></a>

### 计划 2 · 协议错误模块与无状态转交

**状态**：待分析/执行。**建议粒度**：P2a、P2b 各一个提交，不能混做。

**P2a 范围**：将 `claude1_protocol.py` 的错误正则、脱敏、HTML 摘要、
`sanitize_error_text()`、`upstream_error_evidence()`、`transform_error()` 移到
`claude1_protocol_errors.py`（建议名）。保留明确的公开导入入口，不反向 import 主协议文件。

**P2b 范围**：在原协议文件内核对无状态的 RequestAdapter/ResponseAdapter 及其子类、实例表；
可用普通编码/解码函数和显式分发表替换单纯转交。明确传递 provider_type、plan、compatibility_mode
及 receipt，不新增另一套 Adapter 抽象。若外部导出合同需要保留类，先缩小范围，不制造双实现。

**明确不做**：P2a 不改变错误文案/脱敏策略；P2b 不同时改 IR、字段映射或拆流桥。

**验收**：P2a 保持凭证脱敏、普通错误文字、HTML 错误摘要及 Hub 上游错误合同；P2b 保持三个
协议的 golden 请求/响应、OAuth 类型对应格式、strict/visible_lossy、plan、receipt 和输入不变性。
复用协议 contract、转换、Hub 错误测试，检查 npm/install 依赖闭包。
**停止点**：每一子步证明规则不变并提交；P2b 完成不自动进入 IR 改写。

<a id="s21-p3"></a>

### 计划 3 · 配置读取与解释分离

**状态**：待分析/执行。**建议粒度**：先拆纯规范化，再决定读取/缓存是否值得迁移。

**现有问题**：`claude-hub.py::get_config()` 混文件读取、原始 JSON 缓存与有条件的 provider
读取；`validate_config()` / `_config_port()` 还隐式读取环境变量。不能把它直接称为纯函数。

**本计划只做**：明确路径/文件/环境读取者；让规范化逻辑接收 raw、环境覆盖和已取得的 provider
快照，返回规范化配置或同等配置错误。`_validate_routes()` 的能力判断继续使用同一协议矩阵。
可能提取 `claude1_hub_config.py`；是否移动读取缓存由本计划分析决定，不先创建空目录。

**预期调用**：读取外部配置事实 → 规范化配置 → handler 使用配置与快照 → 纯 route。
现有鉴权前后的读库和报错时序须先列出来，不能以“集中读取”为由静默调整。

**明确不做**：不改配置格式、默认值、环境覆盖优先级、热更新或错误状态；不合并 launcher 的
`normalize_hub_config()` 迁移/写入职责；不把凭证与界面 DTO 合成总配置对象。

**验收**：覆盖版本/端口、四槽位、effort、native system role、transport、route requires、
环境覆盖和错误时序；证明纯解释函数不自行读文件/DB。复用 Hub 配置与 routes 合同。
**停止点**：读取与解释的调用方向单一，已有配置继续有效；状态缓存迁移若超范围，留给 P4 或另一个子步。

<a id="s21-p4"></a>

### 计划 4 · Provider 快照状态集中

**状态**：待分析/执行。**前置**：P3 已明确 provider 读取的调用责任。

**本计划只做**：以 `get_providers()`、`_read_provider_rows()`、`_read_provider_snapshot()`
及 `_snapshot_*` 状态为一个职责集合，集中版本、缓存、锁、刷新与指标所有权。
建议模块 `claude1_providers.py`；若用 `ProviderSnapshotCache`，它只拥有这些已存在的状态，
对调用方提供小接口，不再套 Store/Repository/Service 层。`reset_caches()` 应委托状态所有者，
不由别的模块直接修改缓存内部变量。

**预期调用**：Hub 请求快照 → 快照所有者检查权限与版本，必要时刷新 → 返回 provider 数据。
模型选择继续由 `claude1_routing.py` 负责；管理面脱敏 store 不并入含凭证运行记录。

**明确不做**：不改缓存失效依据、TTL、并发锁策略、WAL 复制规则、刷新失败处理或 CC Switch schema；
不改日志格式和密钥存储，不引入跨进程缓存。

**验收**：复用 `test_claude_hub.py` 的只读快照、WAL、single-flight、DB 替换、权限收紧/放宽、
失败不污染缓存、指标与 reset 测试。测试 patch 改到新的状态所有者，不保留两份全局变量。
**停止点**：缓存状态不再散落在 Hub；验证与交付闭包通过后提交，不连带重写配置/日志模块。

<a id="s21-p5"></a>

### 计划 5 · 启动器显示与操作分离

**状态**：待分析/执行。**建议粒度**：P5a 排版、P5b 主题/绘制分别提交。

**P5a 范围**：`claude-provider-once.py` 的 `_char_width/_dwidth/_truncate_display/`
`_drop_display_prefix/_pad_display/_compose_row/_addstr`，形成终端排版与安全绘制职责。
建议 `claude1_terminal.py`；保持无 curses 的环境仍能加载非 TUI 命令，不新增强制 TUI 依赖。

**P5b 范围**：先明确 `C/_logo_pairs/_row_pairs` 的唯一所有者，再逐组迁移 `_init_colors`、
logo 和绘制函数到 `claude1_launcher_view.py`。绘制接收已准备数据，不反向调用 launcher。

**预期调用**：launcher 读取状态 → view 绘制 → launcher 接收操作 → launcher 执行修改/启动。
`_launcher_main()`、`_hub_workspace()` 现有配置修改与探活留在操作侧；不整体搬迁来掩盖耦合。

**明确不做**：不改布局、文案、快捷键、向导、模型默认值；不把终端 TUI 与桌面 UI 合并；
不迁移 `build_settings()` 或 bridge 进程生命周期，它们涉及不同的读配置与资源释放合同。

**验收**：Unicode/全角/组合字符、裁剪、负坐标、窄窗口、footer、logo、setup 的 FakeWindow
实际写入结果不变；测试中的主题赋值与 patch 随状态所有者迁移。保留 launcher 全量、npm/安装验证。
**停止点**：显示不读配置/token、不执行探活或启动；迁移必须靠大量回调或反向 import 时缩小绘制集合。

<a id="s21-p6"></a>

### 计划 6 · 请求编码与响应规则整理

**状态**：待分析/执行，最后推进。**前置**：P2 完成；重新核对共享规则与测试注入点。

**P6a 范围**：先在原文件内逐个让 Chat/Responses 编码函数消费 RequestIR，保留其校验、
内容顺序、错误 code/path、降级记录和工具关联职责；迁移完成后才删除 `_payload_from_request_ir()`。
请求 IR 与编码共享工具结果校验、`_record_lossy()`，应确定单一所有者，不能互相 import。

**P6b 范围**：明确 JSON 响应与 SSE 共用的 stop reason、工具参数、identifier、reasoning 往返
和 usage 规则，再决定请求/响应/流文件归属。只有共享规则形成单向依赖后才迁移流桥；
不能按方法数量把 AnthropicStreamBridge 拆成 mixin 或两套互相重复的桥。

**可选切片**：`SSEParser` / `sse_event` 可独立负责字节到事件的 framing；有独立调用/测试收益
才提取，不为了减少九十行而新增文件。它不拥有成功/失败终态的语义。

**明确不做**：不删 IR 校验；不新增协议；不改 thinking、工具调用、结束原因、usage 或有损转换策略；
不统一 native/transformed 流提交策略，不放宽工具因果保护，不把 EOF 变成成功。
若需要调整下游交付/重放，先按现有 **S20** 完成单独修复，不夹进本计划。

**验收**：请求/响应 golden 与输入不变性；工具结果顺序/重复引用；随机 chunk、UTF-8/换行、
参数增量与快照、终态、usage；保留 Chat 裸 `[DONE]` 的已有降级例外及 Responses 的不同处理。
`test_protocol_sse_invariants.py` 对 `MAX_STREAM_*` 的赋值必须作用于实际定义模块，不能只迁
常量导出而让测试失效。每个子步跑协议、Hub、routes 与完整交付检查。
**停止点**：先完成 P6a 并提交，再单独分析 P6b；共享所有者未确定时不搬流状态机。

### 暂不包含在六个重构计划内的工作

以下继续留在本队列，不因整理计划而默认为已完成或已安排执行：

| 工作 | 当前边界与后续验收 |
| --- | --- |
| 下游失活误重放 | 继续使用 **S20**，先复现、区分上下游异常，证明死客户端不触发额外上游请求 |
| Standalone 协议接入 | 当前 launch 未消费 adapter；先确定支持合同，再接现有桥或限制协议，验证真实请求格式 |
| Standalone 凭证 argv | 当前 Keychain set_secret 通过 argv 传 secret；核实替代机制后单独修复，验参数/错误无凭证及 macOS 实际操作 |
| transport/重放的执行不确定性 | “未收到响应/下游未交付”不证明上游没执行；尝试次数、取消与计费边界单独研究，不叠加重试层 |
| launcher settings 与进程生命周期 | build_settings 隐式读配置，bridge 涉及锁/状态/PID/释放；P5 不顺带处理，后续分别定义合同 |
| 根脚本迁移 src、占位入口接通 | 等模块责任稳定后，单独规划 Python/npm/install 三种入口和导入闭包；六个计划不以搬目录为验收 |
| Go/Rust/桌面 UI 产品身份 | 与主 Python 分开；Go 终态规则不同，不能合并后宣称语义一致，也不整库删除 |
| 展示收口 | 每步同步真实调用链；全面 README/demo 优化在所选代码阶段完成后单独推进，用真实路径录制，不将演示 UI 当上游证据 |

### 之后如何继续

可以直接使用“分析 S21-P1”或“执行 S21-P1”。分析时只核对该卡的函数、依赖、调用前后和
验证合同；执行时只完成一个可验证子步。结束后更新本卡状态与提交证据，不另外新建平行任务队列。
