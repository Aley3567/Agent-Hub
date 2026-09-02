# PRD — gateway M2：canonical 事件流核心（路径 B 正向转换）

## 失效条件

M3（多上游 failover + OpenAI Chat Completions adapter）落地后本文归档；若 M2 范围被推翻重做，以新 PRD 为准。

## 背景与定位

M0/M1 把语义保证权部分收回（修复代理：上游 EOF 时本地补终止三元组），但**翻译的语义权仍在 agentrouter 的 new-api 翻译层手里**——只要 agentrouter 的 /v1/messages 反向转换路径还在用，断流的根因就没消除，只是被网关"发现并补救"。

会诊材料 §3.1 的证据矩阵藏着一个被忽视的事实：**agentrouter 上 deepseek-v4f 的坏路径只有 /v1/messages；/v1/responses 完整 response.completed，/v1/chat/completions 有 [DONE]**。所以与其修补有损翻译的下游，不如做**自己的无损翻译**：

```
M0/M1（修复模式）：
  Claude Code → 网关[透传+补丁] → agentrouter /v1/messages[new-api 坏翻译] → deepseek

M2（正向转换模式，路径 B）：
  Claude Code → 网关[Anthropic 入 → OpenAI Responses 出] → agentrouter /v1/responses[健康路径] → deepseek
```

终止三元组（content_block_stop/message_delta/message_stop）由本地 renderer 合成——**翻译的语义保证权彻底收回到自己手里**，new-api 的坏路径被整体绕开而非修补。

## 范围

### 做

- **P1 canonical 事件层**（新包 `internal/canonical`）：定义协议无关的中间事件类型，作为 adapter → 状态机 → renderer 之间的契约。事件：
  - `MessageStart{message_id, role}`
  - `ContentBlockStart{index, type (text/thinking/tool_use/signature), signature?}`
  - `ContentBlockDelta{index, kind (text/thinking/signature/tool_input), text?}`
  - `ContentBlockStop{index}`
  - `MessageDelta{stop_reason?, usage?}`
  - `MessageStop`
  - `Error{type, message}`
  纯数据结构，无 IO、无上游/下游协议依赖。

- **P2 OpenAI Responses adapter**（新包 `internal/adapter/openairesponses`）：把 `/v1/responses` SSE 流解析为 canonical 事件序列。
  - `response.created` → MessageStart
  - `response.output_item.added` (type=message) → ContentBlockStart{type:text}
  - `response.output_item.added` (type=reasoning) → ContentBlockStart{type:thinking}（注：OpenAI Responses 的 reasoning summary 与 Anthropic thinking 不完全等价；M2 范围内仅做映射骨架，signature 留空）
  - `response.output_text.delta` → ContentBlockDelta{kind:text}
  - `response.reasoning_summary_text.delta` → ContentBlockDelta{kind:thinking}
  - `response.output_item.done` → ContentBlockStop
  - `response.completed` → MessageDelta{stop_reason:"end_turn"} + MessageStop
  - `response.failed` / `response.error` / `response.incomplete` → Error 事件
  - 流提前 EOF（缺 `response.completed`）→ 不在 adapter 内合成终止；交给状态机决定补全与否（沿用 M0 修复语义作为兜底）。

- **P3 Anthropic SSE renderer**（新包 `internal/renderer/anthropic`）：从 canonical 事件序列渲染 Anthropic SSE 帧。
  - 复用 `repair.Machine` 已有的 `encodeFrame` / `closingFrames` 编码逻辑（提取到公共 helper 或直接复用现有函数）。
  - 每个 canonical 事件到来立即渲染并 flush，**不再"扣住 message_stop 直到干净 EOF"**——M2 不需要修复代理，因为终止三元组本就由 adapter 在 response.completed 时产生。
  - 健康路径上 renderer 不做任何"补丁"，只做协议映射。
  - 极短流（1-2 chunk）不重复 message_start：MessageStart 在 renderer 内部幂等，重复事件不重发。

- **P4 请求侧转换器**（在 `internal/proxy` 新增 `transformRequest`）：把 Anthropic /v1/messages 请求体转换为 OpenAI /v1/responses 请求体。
  - messages → input（OpenAI Responses 的 input/messages 字段，按 OpenAI Responses API spec）
  - system → instructions
  - tools → tools（schema 形状近似，工具调用结果按 role=tool 的标准映射）
  - thinking → 保留为 sidecar（OpenAI Responses 不直接支持 Anthropic thinking，但保留 effort 透传给 reasoning.effort——会诊 §4 已证实这是唯一有效入口）
  - max_tokens → max_output_tokens
  - stream: true 不变；上游强制 stream=true（OpenAI Responses 流式）
  - 模型名映射：`claude-opus*` → `deepseek-v4-pro`（或保留 claude-* 让上游映射，取决于 agentrouter 配置；M2 范围内默认透传，由 POLICY_FILE 控制重写）。

- **P5 路径分发**（`internal/proxy/proxy.go` 增加模式开关）：新增 env `TRANSFORM_MODE`：
  - 空（默认）= M0/M1 透传修复模式（行为不变）
  - `openai-responses` = 路径 B：/v1/messages 走 transformRequest → POST 上游 `${UPSTREAM_RESPONSES_PATH:-/v1/responses}` → adapter → renderer → 下游 SSE
  - 其他 /v1/* 路径在两种模式下都透传（M0 行为）
  - 切换不影响 LISTEN_ADDR、UPSTREAM_BASE_URL、POLICY_FILE 等现有配置。

### 不做（M3+）

- OpenAI Chat Completions adapter（路径 B 的另一种上游选择，/v1/chat/completions 健康度仅次于 /v1/responses）。
- 多上游 failover（路径 D）。
- 真实联网实测（需要用户提供 agentrouter 凭证 + 配置切换）——M2 交付物是代码 + 单元测试 + golden 矩阵 + 操作文档，标注"尚未联网实测"。
- canonical 状态机的退化检测（M1 runaway detector 暂不接入 M2 transform 路径，等 M3 把 repair 包重构为 streamguard 后统一接入）。

## 设计红线（沿用 M0/M1，本节复述以备 PR 评审）

1. **Byte fidelity only applies to M0 path.** M2 transform 路径**主动 re-serialize**——这是路径 B 的本质（Anthropic→OpenAI→Anthropic 的双跳翻译）。但 signature 字段如果在转换中被丢弃，renderer **不伪造**——直接不输出 signature 块（保留 Anthropic 客户端对缺 signature 的容忍行为，已经过 golden 样本验证）。
2. **No forged signatures.** 同上，禁止合成假 signature。
3. **Errors stay errors.** 上游 response.failed → 下游 error 事件，不伪装成成功。
4. **No global streaming timeout.** 同 M0。
5. **Downstream write failures cancel upstream.** 同 M0。
6. **Termination authority lives in renderer, not in a repair pass.** M2 的核心区别：终止三元组是 renderer 在 adapter 给出 MessageStop 时合成的，不是"上游 EOF 后补丁"。这是语义权收回的体现。

## 验收标准

1. `gofmt -l .`、`go vet ./...`、`go test ./...` 干净；二进制可构建。
2. M0/M1 现有 61 个测试（45 + 16）仍全绿——**M2 不改 M0/M1 现有代码**，只新增包 + 在 proxy.go 加模式分支。
3. 新增 canonical 包、openairesponses adapter、anthropic renderer 各自的单元测试全绿。
4. 新增 transform 路径的 golden 矩阵测试：用一个 OpenAI Responses 风格 SSE 流（人工 fixture 或转换自现有 deepv4f-thinking.sse）作为 adapter 输入，断言 renderer 输出包含完整 message_start → content_block_start → delta 序列 → content_block_stop → message_delta → message_stop 三元组、不重复 message_start、错误事件不伪装成功。
5. README 更新：路径 B 操作说明 + env 配置示例 + "尚未联网实测"标注。

## 客户端侧配套（不在本 PRD 实现范围）

- ~~切换到路径 B 后保留 thinking 注入策略~~ —— **2026-08-25 推翻**：`inject_budget_tokens` 已从 `internal/policy` 整体删除。上游丢弃该值、注入打破请求字节保真、且 Opus 4.7/4.8、Opus 5、Sonnet 5、Fable 5 对 `budget_tokens` 直接返回 400。reasoning.effort 仍是唯一有效入口，其注入是 M2.1（见 work-queue S15）。
- agentrouter 凭证由用户在真机验收时配置。
