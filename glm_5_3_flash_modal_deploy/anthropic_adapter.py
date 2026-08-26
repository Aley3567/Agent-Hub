# -*- coding: utf-8 -*-
"""Anthropic Messages ↔ OpenAI ChatCompletions 协议翻译层。

纯函数实现，仅依赖标准库；与 Modal / SGLang 完全解耦，
全部映射逻辑由 tests/test_anthropic_adapter.py 离线验证。

设计原则（继承本仓库协议桥纪律）：
- 错误原样暴露：上游错误体不裁剪语义，失败绝不伪装成成功；
- 无法无损转换的字段走 DEGRADE 路径记录告警后放行，而不是拒绝请求。
"""

import json
import uuid

MODEL_NAME = "glm-5.3-flash"
"""对外声明的模型名，同时作为上游 --served-model-name，两侧强制一致。"""

DEGRADED = "非文本 content block 已丢弃"


# ---------------------------------------------------------------------------
# 请求方向: Anthropic /v1/messages -> OpenAI /v1/chat/completions
# ---------------------------------------------------------------------------

def to_openai_request(body):
    """把 Anthropic 请求体翻译为 OpenAI chat.completions 请求体。

    返回 (payload, degrade_warnings)。degrade_warnings 为无法无损转换的
    字段清单字符串，调用方负责落日志（对应 HUB_DEGRADE_* 纪律）。
    """
    warnings = []
    payload = {
        "model": MODEL_NAME,
        "max_tokens": body.get("max_tokens", 4096),
        "stream": bool(body.get("stream", False)),
    }
    for src, dst in (("temperature", "temperature"), ("top_p", "top_p"), ("top_k", "top_k")):
        if body.get(src) is not None:
            payload[dst] = body[src]
    if body.get("stop_sequences"):
        payload["stop"] = body["stop_sequences"]

    messages = []
    system = _flatten_system(body.get("system"))
    if system:
        messages.append({"role": "system", "content": system})

    for msg in body.get("messages", []):
        translated, warns = _translate_message(msg)
        messages.extend(translated)
        warnings.extend(warns)

    if body.get("tools"):
        payload["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name"),
                    "description": t.get("description", ""),
                    # Anthropic input_schema 与 OpenAI parameters 同为 JSON Schema
                    "parameters": t.get("input_schema") or {"type": "object"},
                },
            }
            for t in body["tools"]
        ]
    if payload.get("stream"):
        # 让上游在末尾补 usage 块；不支持该字段的版本会忽略它
        payload["stream_options"] = {"include_usage": True}

    # tool_choice 映射（none/auto 与 OpenAI 同形；tool 强制指定时取其名字）
    tc = body.get("tool_choice")
    if isinstance(tc, dict):
        kind = tc.get("type")
        if kind == "auto":
            payload["tool_choice"] = "auto"
        elif kind == "any":
            payload["tool_choice"] = "required"
            warnings.append("TOOL_CHOICE_ANY_TO_REQUIRED")
        elif kind == "tool" and tc.get("name"):
            payload["tool_choice"] = {
                "type": "function",
                "function": {"name": tc["name"]},
            }

    payload["messages"] = messages
    return payload, warnings


def _flatten_system(system):
    """system 兼容 str 与 [{type:"text",text}] 两种形态，缺失返回 None。"""
    if not system:
        return None
    if isinstance(system, str):
        return system
    parts = [b.get("text", "") for b in system if isinstance(b, dict) and b.get("type") == "text"]
    return "\n".join(p for p in parts if p) or None


def _stringify_content(content):
    """content 块数组里的文本拼接为单一字符串；其余类型丢弃并留痕。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    texts, degraded = [], False
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            texts.append(block.get("text", ""))
        else:
            degraded = True
    text = "".join(texts)
    return (text + "\n") if (degraded and text) else ("（此消息含已丢弃的非文本内容）" if degraded else text)


def _translate_message(msg):
    """单条消息翻译。一条 Anthropic 消息可能展开为一到两条 OpenAI 消息：
    - assistant 的 thinking/text 拼接进 content，tool_use 转 tool_calls;
    - user 的 tool_result 块拆出独立的 role:"tool" 消息。
    """
    role = msg.get("role", "user")
    warnings = []
    content = msg.get("content")

    if role != "assistant":
        rest_text, tool_results = [], []
        for block in _as_blocks(content, msg):
            btype = block.get("type")
            if btype == "tool_result":
                inner = _stringify_content(
                    block["content"] if isinstance(block.get("content"), list) else block.get("content", "")
                )
                tool_results.append({"role": "tool", "tool_call_id": block.get("tool_use_id"), "content": inner})
            elif btype == "image":
                warnings.append(DEGRADED)
            else:
                rest_text.append(_block_text(block))
        out = [{"role": role, "content": "".join(rest_text)}] if "".join(rest_text) else []
        out.extend(tool_results)
        return out, warnings

    # assistant 分支
    texts, tool_calls = [], []
    for block in _as_blocks(content, msg):
        btype = block.get("type")
        if btype == "tool_use":
            tool_calls.append({
                "id": block.get("id"),
                "type": "function",
                "function": {
                    "name": block.get("name"),
                    "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False),
                },
            })
        elif btype == "thinking":
            continue  # 历史思考块不回传上游（推理模型自含状态），避免方言字段被拒
        else:
            texts.append(_block_text(block))
    assistant_msg = {"role": "assistant", "content": "".join(texts)}
    if tool_calls:
        assistant_msg["tool_calls"] = tool_calls
    return [assistant_msg], warnings


def _as_blocks(content, msg):
    """content 归一为块列表；裸字符串包装成单个 text 块。"""
    if content is None and msg.get("content") is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content if isinstance(b, dict)]


def _block_text(block):
    return block.get("text", "") if block.get("type") == "text" else ""


# ---------------------------------------------------------------------------
# 响应方向 1: 非流式 OpenAI completion -> Anthropic message
# ---------------------------------------------------------------------------

_STOP_REASON = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use"}
_FALLBACK_STOP = "end_turn"


def new_message_id():
    return "msg_" + uuid.uuid4().hex


def from_openai_response(completion):
    """非流式翻译。失败绝不伪装成功：无 choices 时抛 ValueError 由调用方转错误。"""
    choice = (completion.get("choices") or [{}])[0]
    delta = choice.get("message") or {}
    blocks, index = [], 0

    reasoning = delta.get("reasoning_content")
    if reasoning:
        blocks.append({"type": "thinking", "thinking": reasoning, "index": index}); index += 1
    text = delta.get("content")
    if text:
        blocks.append({"type": "text", "text": text, "index": index}); index += 1
    for call in delta.get("tool_calls") or []:
        try:
            args = json.loads(call["function"].get("arguments") or "{}")
        except (json.JSONDecodeError, KeyError):
            args = {}
        blocks.append({
            "type": "tool_use",
            "id": call.get("id"),
            "name": (call.get("function") or {}).get("name"),
            "input": args,
            "index": index,
        }); index += 1

    usage = completion.get("usage") or {}
    return {
        "id": new_message_id(),
        "type": "message",
        "role": "assistant",
        "model": MODEL_NAME,
        "content": [{k: v for k, v in b.items() if k != "index"} for b in blocks],
        "stop_reason": _STOP_REASON.get(choice.get("finish_reason"), _FALLBACK_STOP),
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


def anthropic_error(err_type, message):
    return {"type": "error", "error": {"type": err_type, "message": message}}


# ---------------------------------------------------------------------------
# 响应方向 2: 流式增量状态机（OpenAI chunk 流 -> Anthropic SSE 事件序列）
# ---------------------------------------------------------------------------

class StreamTranslator:
    """把上游 chat.completions chunk 字典逐个喂进来，吐出 Anthropic SSE 事件字典。

    断流安全：连接中断时调用方只需调 aborted_error() 补一个 error 事件，
    绝不伪造 message_stop —— 与本仓库「终态只能来自上游真实终态」纪律一致。
    """

    def __init__(self):
        self.msg_id = new_message_id()
        self._next_index = 0          # 下一个可用的 content block index
        self._open = {}               # kind -> anthropic index（当前打开的块）
        self._tools = {}              # 上游 tool_call index -> {"started","id","name","anthropic_idx"}
        self._stop_reason = None
        self._usage = None
        self._started = False

    # ---- 对外接口 ----

    def feed(self, chunk):
        """消费一个已解析的上游 chunk dict，返回事件 dict 列表。"""
        events = []
        if not self._started:
            self._started = True
            events.append({"event": "message_start", "data": {
                "type": "message_start",
                "message": {
                    "id": self.msg_id, "type": "message", "role": "assistant",
                    "model": MODEL_NAME, "content": [],
                    "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": chunk.get("usage", {}).get("prompt_tokens", 0)
                              if isinstance(chunk.get("usage"), dict) else 0,
                              "output_tokens": 0},
                },
            }})

        choice = (chunk.get("choices") or [{}])[0] if chunk.get("choices") else {}
        delta = choice.get("delta") or {}

        if delta.get("reasoning_content"):
            events += self._switch_to(("thinking",))
            events.append(_delta_event(self._open["thinking"], {
                "type": "thinking_delta", "thinking": delta["reasoning_content"]}))

        if delta.get("content"):
            events += self._switch_to(("text",))
            events.append(_delta_event(self._open["text"], {
                "type": "text_delta", "text": delta["content"]}))

        for call in delta.get("tool_calls") or []:
            up_idx = call.get("index", 0)
            state = self._tools.setdefault(up_idx, {})
            fn = call.get("function") or {}
            if not state.get("started"):
                events += self._close_all_open()
                state.update(started=True, id=call.get("id"), name=fn.get("name"))
                state["anthropic_idx"] = self._next_index; self._next_index += 1
                events.append({"event": "content_block_start", "data": {
                    "type": "content_block_start", "index": state["anthropic_idx"],
                    "content_block": {"type": "tool_use", "id": state["id"],
                                      "name": state["name"], "input": {}}}})
                self._open[("tool", up_idx)] = state["anthropic_idx"]
            args_delta = fn.get("arguments")
            if args_delta:
                events.append(_delta_event(state["anthropic_idx"], {
                    "type": "input_json_delta", "partial_json": args_delta}))

        if choice.get("finish_reason"):
            self._stop_reason = _STOP_REASON.get(choice["finish_reason"], _FALLBACK_STOP)
        if isinstance(chunk.get("usage"), dict) and chunk["usage"]:
            self._usage = chunk["usage"]
        return events

    def flush(self):
        """上游 [DONE] 到达后收尾：关闭全部块、发终止事件。只应被真实终态调用。"""
        if not self._started:
            return []  # 上游没吐过任何块就结束，不伪造半条消息
        events = []
        for _, idx in sorted(self._open.items(), key=lambda kv: kv[1]):
            events.append({"event": "content_block_stop", "data":
                           {"type": "content_block_stop", "index": idx}})
        self._open.clear()
        out_tokens = (self._usage or {}).get("completion_tokens", 0)
        in_tokens = (self._usage or {}).get("prompt_tokens", 0)
        events.append({"event": "message_delta", "data": {
            "type": "message_delta",
            "delta": {"stop_reason": self._stop_reason or _FALLBACK_STOP, "stop_sequence": None},
            "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens}}})
        events.append({"event": "message_stop", "data": {"type": "message_stop"}})
        return events

    def aborted_error(self, detail):
        """断流/上游异常路径：只补 error 事件，不发 message_stop。"""
        return [{"event": "error", "data": anthropic_error("api_error", detail)}]

    # ---- 内部：块开闭管理 ----

    def _switch_to(self, kinds):
        """确保 kinds 中各块处于打开态；先关闭与其互斥的已开块。"""
        events = []
        for kind in kinds:
            if kind in self._open:
                continue
            events += self._close_all_open()
            events.append({"event": "content_block_start", "data": {
                "type": "content_block_start", "index": self._next_index,
                "content_block": {"type": kind}}})
            self._open[kind] = self._next_index
            self._next_index += 1
        return events

    def _close_all_open(self):
        events = []
        for kind, idx in list(self._open.items()):
            events.append({"event": "content_block_stop", "data":
                           {"type": "content_block_stop", "index": idx}})
        self._open.clear()
        return events


def _delta_event(index, delta):
    return {"event": "content_block_delta", "data":
            {"type": "content_block_delta", "index": index, "delta": delta}}


def sse_frame(event):
    """把事件 dict 编码为 SSE 帧。ping/error 等命名事件统一走 event: 行。"""
    import json as _json
    name = event.get("event", "message")
    body = _json.dumps(event.get("data"), ensure_ascii=False)
    if name == "message":
        return f"data: {body}\n\n"
    return f"event: {name}\ndata: {body}\n\n"
