# PRD — gateway M1：per-model 策略层（思考护栏 + 诚实截断）

## 失效条件

M2（canonical 事件流核心）落地后本文归档；若 M1 范围被推翻重做，以新 PRD 为准。

## 背景与证据

M0 已完成 Anthropic→Anthropic 透传修复层（EOF 补终止事件）。压测暴露的剩余问题：

1. **思考失控**：deepseek-v4 系列（agentrouter 的 deepseek-v4f、百炼的 deepseek-v4-flash-0731）在客户端不传 thinking 参数时思考常开且无约束，实测退化死循环（逐字插数字）烧光 8192 token 预算、正文 0 字符。证据：`testdata/sse/B-plain-long.sse`、`testdata/sse/BL-plain.sse`。传任意 thinking 参数（含 disabled、小预算）后思考收敛、正文完整。证据：`testdata/sse/A-think-long.sse`、`D-disabled.sse`、`E-budget512.sse`。
2. **终止语义不诚实**：M0 对一切 EOF 补 `stop_reason:"end_turn"`；预算耗尽/截断应如实为 `max_tokens`。
3. **极短流重复 message_start**：new-api 源码审计发现其 `OaiStreamHandler` 滞后一个 chunk，1–2 chunk 的流会重复发 `message_start`（`relay/channel/openai/helper.go` HandleFinalResponse 未补 IncrSendResponseCount）。observer 需容忍。
4. 官方修复 PR QuantumNous/new-api#6721 未合并，维护者表态不为三方渠道兜底——只能本地解决。

## 范围

### 做

- **P1 策略表**：JSON 配置文件（`POLICY_FILE`，缺省无策略=纯透传修复，行为与 M0 一致）。按模型名匹配：
  ```json
  {
    "models": {
      "deepseek-v4f": {
        "thinking": {"inject_budget_tokens": 4096, "max_budget_tokens": 8192},
        "runaway_detection": {"enabled": true}
      }
    }
  }
  ```
- **P2 请求改写（仅 anthropic `/v1/messages` 路径）**：请求体允许 JSON 解析改写（请求侧无 signature 完整性问题，字节保真红线只约束响应）：
  - 无 `thinking` 字段 → 注入 `{"type":"enabled","budget_tokens": inject_budget_tokens}`；
  - 有 `budget_tokens` → clamp 到 `max_budget_tokens`；
  - `thinking.type=="disabled"` → 不动。
  - 无匹配策略的模型：body 原样字节转发。（措辞修订：配置了策略表的 `/v1/messages` 请求都会读 body 以取 model 字段，未命中则不解析改写。）
- **P3 退化检测与截断（流式响应）**：observer 旁路对 thinking/text 增量文本做滑窗检测。实现修正（实现者按实测证据调整，本文同步）：PRD 原定的「最长 border 短模式重复」在真实失控样本 B-plain-long 上零触发——实际退化是逐字插**递增**数字，无逐字重复模式。落地为**双信号**，任一触发即截断：(a) 尾部 ≤P 周期短模式重复 ≥K 次；(b) 最近 W=512 rune 内 ASCII 数字占比 ≥0.45（经验阈值：B 峰值 0.527、百炼 BL-plain 峰值 0.408、健康流 ≤0.16，分离带余量约 0.04，属按样本调参，已知局限）。触发后：停止转发上游后续内容，补写 `: truncated-by-gateway: runaway-thinking` 注释 + 关闭未闭合 block + `message_delta{stop_reason:"max_tokens"}` + `message_stop`，并取消上游请求。注：stop_reason 取 `max_tokens` 是近似诚实（效果等同预算耗尽），注释标记承担可观测性。
- **P4 诚实 stop_reason（M0 语义修订）**：网关主动截断 → `max_tokens`；上游干净 EOF 但事件流缺失终止 → 维持 `end_turn`（无法确知，不编造）；上游读错误 → 仍只发 error 事件（M0 行为不变）。
- **P5 observer 健壮性**：重复 `message_start` 不重置已完成状态；测试覆盖 1–2 chunk 极短流。

### 不做（M2+）

- canonical 事件流核心重构、多渠道 failover、请求侧凭证管理、响应体 JSON 改写（含注入空 signature——仅在有真实客户端抱怨后再评估）。
- OpenAI responses/chat 路径的 reasoning effort 改写（Codex 侧暂用客户端配置解决，见下）。

## 实现思路

- `internal/policy`：策略表加载与匹配（纯逻辑：读 JSON、按 model 返回策略指针）。无策略文件时所有函数返回 nil。
- `internal/proxy` 请求路径：仅当路径为 `/v1/messages` 且策略命中时读 body → `encoding/json` 解析 → 改写 thinking → 重序列化转发；否则保持现状流式转发。
- `internal/repair` 扩展为 `internal/streamguard`（或保持包名 `repair`，内部加滑窗检测器）：`Observe` 增传增量文本，新增返回值或回调表示「触发截断」；`Finalize` 增加截断原因参数区分 P3/P4。
- 退化检测算法从简：维护最近 W 字节的 ring buffer；每次增量后检查最长 border（后缀=前缀）重复次数，≥K 触发。不引入 NLP，宁可漏检不误伤——误伤代价是切断正常输出，漏检代价只是回到 M0 行为。
- 配置热加载不做；重启生效。

## 验收标准

1. golden 矩阵全绿（现有好/坏流 + 新增）：`B-plain-long.sse` 触发截断且终止事件完整、stop_reason=max_tokens；`BL-plain.sse`（已有完整终止的失控流）字节透传不干预；1–2 chunk 极短流不重复 message_start；无策略文件时全部行为=M0。
2. `gofmt -l`、`go vet ./...`、`go test ./...` 干净；二进制可构建。
3. 实测：策略文件配 deepseek-v4f 后，`/tmp/stress/run.sh` 的 B 组同款请求经网关→思考被预算约束或截断、正文有输出或优雅结束。
4. README 更新：策略配置说明 + 新增红线「误伤优先避免」。

## 客户端侧配套（不在本 PRD 实现范围，另行执行）

- CC Switch agentrouter 渠道 env 加 `MAX_THINKING_TOKENS=4096`（Claude Code 侧）。
- Codex provider 配 `model_reasoning_effort="low"`。
