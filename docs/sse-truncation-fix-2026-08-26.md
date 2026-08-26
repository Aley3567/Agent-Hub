# SSE 思考期断流两层修复 —— 全过程记录（2026-08-26）

> **失效条件：** 上游网关修复终态语义后（一个观察周期零 IncompleteSSE）重放层可归档；
> 实验账本与三副本拓扑记录永不归档（化名口径与排除项的唯一出处）。

状态：【已完成并部署】。本文是诊断、设计、实验、部署的完整证据链归档；
变更登记见 `docs/work-queue.md` S19 卡。

## 一、症状

某中转网关家族渠道 + glm-5.3，首条消息：思维链短暂出现即消失、回复为空、
报「Connection lost mid-response」；Ctrl+O 仍能看到思考内容。间歇性发作。

## 二、根因（已实锤）

上游网关在思考期把 SSE 流**干净关闭**（EOF），不发 `message_stop` 也不发
`error` 终态事件。hub 原行为检测到 IncompleteSSE 后强断下游连接，客户端看到
的就是裸断。证据链：

1. 本机错误 journal（~/.cc-switch/logs/claude-hub-errors.jsonl）61 条
   `IncompleteSSE` 跨 opus/gpt-5.6-sol/deepseek/glm-5.3，全部集中于该网关家族，
   时长 2.4s–333s；
2. 发作当日 glm-5.3 两条实况（2.7s/18.4s）全部死在 `thinking_delta`、正文零字节；
3. 实况抓包证实上游 EOF 无终态；
4. 同时段 h1.1 对照探针（小响应/大响应/gzip/真 CC）全通过 → 截断是**间歇性**
   而非确定性。这一条推翻了旧结论「干净 EOF 重放只会复现失败」——该前提仅在
   正文已可见后依然成立，思考期（客户端零字节）不成立。

## 三、客户端渲染实验账本（选型依据，CC 2.1.229 `-p` 模式）

| 实验 | 注入方式 | CC 表现 | 结论 |
|---|---|---|---|
| ① | SSE 注释行心跳 `: ka` | 正常渲染，日志可见 HIT | 心跳可行但需提前 prepare 下游，与跨渠道 failover 重放冲突，弃用 |
| ② | 流中合成 `event:error` 帧 | 误导性「empty or malformed response」+ 自动重试一次 | 不能当通用失败终局用 |
| ③ | 干净 EOF 无终态 | **静默空回 exit 0，数据丢失不可见** | 最劣形态，必须保证走不到客户端 |
| 补 | 裸 RST | 可见的 mid-response 报错 | 失败可见但体验差 |

## 四、修复设计（两层）

宪法约束：失败绝不伪装成功；断流不补 message_stop；默认放行例外才拒；deg 码留痕。

1. **具名终局**（提交后截断）：交出已到字节 + 尾部补一条具名
   `event:error`(api_error，保留「mid-response」措辞供续接钩子匹配) + 干净关闭。
   失败仍可见、可渲染、可 hook，不再裸 abort。
2. **思考期扣留 + 静默重放**（提交前截断）：tracker 新增 `commit_started`
   分类（message_start/ping/thinking 系列扣留，其余 payload 一律视为正文放行——
   可见性优先于更长的隐形扣留）；扣留上限 1MiB / 45s 双保护窗（初版 120s，当晚
   依据截断点位数据与 CC 静默耐受实验收紧到 45s，见第九节）；窗内干净 EOF
   且下游零字节 → `UpstreamStreamReplayable` 静默重放（预算沿用
   STREAM_REPLAY_ATTEMPTS），每次尝试记 `HUB_DEGRADE_STREAM_REPLAYED`；
   超限降级到第 1 层。

## 五、部署拓扑发现（重要欠账更新）

实际运行拓扑是**三副本**，不是两份：

1. 开源仓 `~/Desktop/claude-hub`（main 分支）；
2. 个人仓 `~/.claude/claude1-personal`（personal 分支，含个人功能与遥测）；
3. **本机运行副本 `~/.claude/scripts/claude-hub.py`**——hub 由 provider-once
   每会话按需 `Popen([HUB_SCRIPT,"serve"])` 拉起，真正生效的是这份；它带有
   只存在于本机的 8 月下旬热修（如 preroutefix），从未回流任何仓库。

S13 记录的「双向分叉」实为三向分叉。本次同步方向：①→② cherry-pick，
②→③ 手工移植（活桥无 _TurnJournal，helper 直调其 record_error 并保留
个人遥测字段）。

## 六、验证记录

- 开源仓全量 906 测试绿（新增 4 条回归：静默重放 / 预算耗尽 504 /
  字节上限降级 / 时间窗降级）；个人仓全量 840 测试绿。
- 合成 flaky 上游端到端三层验收：
  - A（HTTP 层）：首试思考期截断被静默重放，客户端收到完整 SSE 以
    message_stop 结尾；errors.jsonl 恰 1 条含 deg 码；
  - B（真客户端）：真 CC `-p 'hi'` 输出完整回答 exit 0，对故障零感知；
  - C（反向防伪装）：正文期持续截断场景下客户端仍收到可见失败——
    失败路径没有被关掉。
- 过程中排掉的三个假象：假上游未读请求体触发 RST 自斩响应流；flaky 分支
  漏发终态帧；一次「真 CC 成功」实为 settings.json 抢占路由（须用
  `--settings` overlay 才能覆盖 ANTHROPIC_BASE_URL=127.0.0.1:15721）。

## 七、提交清单

| 仓库/分支 | Commit | 内容 |
|---|---|---|
| Desktop/claude-hub main | `477a0b4` | 具名 error 终局（接手并发会话工作并验证） |
| Desktop/claude-hub main | `4adab02` | thinking 扣留 + 静默重放 |
| Desktop/claude-hub main | `ef3f31a` | S19 卡部署状态回写 |
| claude1-personal personal | `f4614bc` / `6a33e49` | 两层修复 cherry-pick（冲突解决含恢复被静默丢弃的 journal/log_prefix 绑定） |
| 运行副本 scripts/ | 无 git | 原子替换上线，备份 `claude-hub.py.bak-s19replay-20260826-171457` |

以上均未 push。

## 八、OpenAI 格式路径（GLM / deepseek-v4-flash 常走）的现状

本轮两提交只覆盖 native anthropic SSE 路径（claude-hub.py）。openai_chat /
openai_responses 转换路径在 `claude1_protocol.py`，其对「无终态关闭」的处理是
`ProtocolTransformError(HUB_SSE_MISSING_TERMINAL)` 硬错：失败可见（优于旧 native
行为）、但没有思考期静默重放、也不向客户端交还已收字节。即同一上游截断病
在该路径上表现为每次都报错，吃不到本次修复红利。移植候选点：
AnthropicStreamBridge 的 `close_stream()` 缺终态分支，可复用同套 holdback +
commit_started 分类思路（需另行开卡）。

## 九、剩余不确定性与失效条件

- 真实上游自然复发验证未完成：下次 glm-5.3 再遇断流，看 errors.jsonl 出现
  `HUB_DEGRADE_STREAM_REPLAYED` 且会话无感即闭环。
- 三副本收敛（S13 扩展）仍未做：scripts 版热修尚未回流任何仓库。
- 体感卡与静默窗：扣留期客户端零字节，思考越长静默越久。实测真 CC 对 75s
  纯静默（中途停顿后恢复）耐受无恙；SSE 注释心跳不会改变 CC 渲染、且一旦
  发出即永久失去该请求的静默重放资格，故不采用；改用收紧保护窗
  （120s→45s）封顶最坏静默。若未来出现「思考 >45s 才被截断」的 deg 数据，
  再重审该窗口或引入带宽限期的心跳。
- 失效条件：上游网关修复终态语义后（一个观察周期零 IncompleteSSE），重放
  逻辑可归档保留；若出现「扣留窗内重放后仍缺正文」的新形态，说明截断点位
  后移到正文早期，需要重审 commit_started 分类边界。
