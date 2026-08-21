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
  但已漂移：40 个前端文件 + 7 个 Rust 文件内容不同；**整个 `UI/` 尚未纳入 git**。
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

**目的**：约 33000 行代码完全在版本控制之外——没历史、没备份、漂移不可见。
这也是"Windows 端没做好"难受的根源：没有 diff 可看，只能靠记忆。

**做法**
1. 处理 15 处 `secret_guard` 命中：改占位符，或加精确类别的
   `secret-guard: allow <category>` 注释（私密指纹还需追加报告中的短哈希）。
   **不使用 `--no-verify` 绕过。**
2. `.gitignore` 排除 `node_modules/`、`dist/`、`src-tauri/target/`。
3. `git add UI/` 并提交。

**验收合同**
1. `python3 scripts/secret_guard.py --staged` 通过。
2. 提交后 `git status` 干净；构建产物与依赖目录未入库。
3. 两端 `npm run typecheck` 各自通过（或记录当前失败项，不假装通过）。

**明确不做**：修漂移、同步那 14 项只落在 `macos/` 的修复（S4 负责）。

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

**目的**：40 个前端文件 + 7 个 Rust 文件的差异里，分清**平台必要差异**
（圆角、字体、动效时长、亚克力层、路径处理——`UI/README.md` 明说两端可以偏离）
与**漏同步的修复**。

**做法**：逐文件对账，产出表：文件 | 差异性质（平台必要 / 漏同步 / 待判定）| 处理动作。

**验收合同**：表覆盖全部 47 个差异文件；"漏同步"项各有对应修复卡或直接修掉；
"平台必要"项在 `UI/DESIGN.md` 有依据。

**明确不做**：把两端强行统一——分目录本身就是为了允许偏离。

---

## S5 · 观测出口（原 P0 队列）

**细化队列**：`p0-tasks.md`。当前状态：T0.0a ✅、T0.0b ✅、T0.0c 未完成、
T0.0d ⚠️（Nebius 语义不兼容，已结论）、T0.0e ✅；**T0.1–T0.6 全部未开始**。

**为什么排在这里**：它的 DoD（"任意一次降级发生后能在 errors/usage 查到"）是对的，
且是协议层宽容化的前置。但它不解决当前 60% 的失败（超时与断流），
也不解决 token 漏损，所以让位给 S1–S3。

**开卡条件**：S1 完成且 S3 有结论后，从 `p0-tasks.md` 顶部拿 T0.1。

---

## S6 · codex 战线扩展（推后）

**现状**：`codex1` 已落地可用（影子 `CODEX_HOME` + profile 层叠 + `env_key`，
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

**状态**：【待建】。2026-08-20 对 `UI/macos/` 做了一轮视觉翻新（侧栏内缩圆角选中块、
基准字号 13→14、图标 16→18、控件/行高/徽章整体上调、深浅色板拉开层次），
`UI/DESIGN.md` 已同步为新数值的唯一真理来源。**`UI/windows/` 的 tokens 与组件
样式仍是旧数值**，已落后于 DESIGN.md。

**做法**：按 DESIGN.md §2/§3/§4 重新生成 `UI/windows/src/styles/tokens.css`
（注意 §5 平台差异表：Windows 圆角更方、行高 -2px=38、按钮高 -2px、字号基准同档），
再逐个对账 windows 侧组件 .module.css 中与 macOS 侧本次改动对应的写法
（侧栏内缩块、Button/Table/Badge/Input/Select/Switch 尺寸与圆角、Card 阴影）。

**验收合同**：windows 端 `npm run typecheck` 与 `build:renderer` 绿；
两端同视图截图对比，差异都能指到 DESIGN.md §5 的某一行。

**明确不做**：改 Windows 的平台差异本身（Mica、自绘标题栏、可见滚动条等保持原样）。

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
