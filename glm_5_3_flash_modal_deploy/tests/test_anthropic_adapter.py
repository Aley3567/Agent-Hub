# -*- coding: utf-8 -*-
"""anthropic_adapter 离线协议测试。仅标准库，`make test` 或 unittest 直跑。"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from anthropic_adapter import (  # noqa: E402
    MODEL_NAME,
    StreamTranslator,
    from_openai_response,
    sse_frame,
    to_openai_request,
)


def _events_names(events):
    return [e["event"] for e in events]


def _feed_chunks(chunks):
    t = StreamTranslator()
    out = []
    for c in chunks:
        out += t.feed(c)
    return t, out


class TestRequestTranslation(unittest.TestCase):
    def test_basic_text_and_system(self):
        body = {
            "model": "whatever", "max_tokens": 128, "stream": False,
            "system": "你是工程师",
            "messages": [{"role": "user", "content": "hi"}],
        }
        payload, warns = to_openai_request(body)
        self.assertEqual(payload["model"], MODEL_NAME)   # 外部请求的 model 名被强制对齐
        self.assertEqual(payload["messages"][0], {"role": "system", "content": "你是工程师"})
        self.assertEqual(payload["messages"][1]["content"], "hi")
        self.assertEqual(warns, [])

    def test_tool_roundtrip(self):
        body = {
            "max_tokens": 512,
            "tools": [{"name": "get_weather", "description": "d",
                       "input_schema": {"type": "object", "properties": {}}}],
            "messages": [
                {"role": "user", "content": "天气?"},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "..."},
                    {"type": "tool_use", "id": "t1", "name": "get_weather", "input": {"city": "上海"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1",
                     "content": [{"type": "text", "text": "26 度"}]},
                ]},
            ],
        }
        payload, warns = to_openai_request(body)
        roles = [m["role"] for m in payload["messages"]]
        self.assertEqual(roles, ["user", "assistant", "tool"])
        call = payload["messages"][1]["tool_calls"][0]
        self.assertEqual(call["function"]["name"], "get_weather")
        self.assertEqual(json.loads(call["function"]["arguments"]), {"city": "上海"})
        # thinking 块不回传上游
        self.assertNotIn("...", json.dumps(payload["messages"]))
        self.assertEqual(payload["messages"][2],
                         {"role": "tool", "tool_call_id": "t1", "content": "26 度"})
        # input_schema 应原样透传给上游 parameters
        self.assertEqual(payload["tools"][0]["function"]["parameters"],
                         {"type": "object", "properties": {}})

    def test_tool_choice_variants(self):
        for tc, expect in (
            ({"type": "auto"}, "auto"),
            ({"type": "any"}, "required"),
            ({"type": "tool", "name": "f1"}, {"type": "function", "function": {"name": "f1"}}),
        ):
            payload, _ = to_openai_request({"messages": [], "tool_choice": tc})
            self.assertEqual(payload.get("tool_choice"), expect)


class TestNonStreamingResponse(unittest.TestCase):
    def test_full_mapping(self):
        completion = {
            "choices": [{
                "message": {"reasoning_content": "想一下", "content": "答案",
                            "tool_calls": [{"id": "c1", "function": {"name": "f", "arguments": '{"a":1}'}}]},
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        msg = from_openai_response(completion)
        types = [b["type"] for b in msg["content"]]
        self.assertEqual(types, ["thinking", "text", "tool_use"])
        self.assertEqual(msg["stop_reason"], "tool_use")
        self.assertEqual(msg["usage"], {"input_tokens": 10, "output_tokens": 5})
        self.assertEqual(msg["content"][2]["input"], {"a": 1})

    def test_broken_arguments_not_crash(self):
        completion = {"choices": [{
            "message": {"tool_calls": [{"id": "x", "function": {"name": "f", "arguments": "{oops"}}]},
            "finish_reason": "tool_calls",
        }]}
        msg = from_openai_response(completion)
        self.assertEqual(msg["content"][0]["input"], {})   # 坏参数降级为空，不炸


class TestStreamingTranslator(unittest.TestCase):
    def test_reasoning_then_text(self):
        chunks = [
            {"choices": [{"delta": {"role": "assistant"}}]},
            {"choices": [{"delta": {"reasoning_content": "思考A"}}]},
            {"choices": [{"delta": {"content": "正文B"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}},
        ]
        t, events = _feed_chunks(chunks)
        events += t.flush()
        names = _events_names(events)
        self.assertEqual(names[0], "message_start")
        self.assertIn("message_stop", names)
        # 块索引顺序: thinking(0), text(1); 切换时必须先 stop 再 start
        starts = [e for e in events if e["event"] == "content_block_start"]
        self.assertEqual([s["data"]["index"] for s in starts], [0, 1])
        stops = [e for e in events if e["event"] == "content_block_stop"]
        self.assertEqual([s["data"]["index"] for s in stops], [0, 1])
        last = events[-2]["data"]
        self.assertEqual(last["delta"]["stop_reason"], "end_turn")
        self.assertEqual(last["usage"], {"input_tokens": 7, "output_tokens": 3})

    def test_tool_call_accumulation(self):
        chunks = [
            {"choices": [{"delta": {"content": "我来查"}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "u1", "function": {"name": "f", "arguments": '{"a":'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": '1}'}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
        ]
        t, events = _feed_chunks(chunks)
        events += t.flush()
        starts = [e for e in events if e["event"] == "content_block_start"]
        tool_start = [s for s in starts if s["data"]["content_block"].get("type") == "tool_use"]
        self.assertEqual(len(tool_start), 1)
        idx = tool_start[0]["data"]["index"]
        partials = "".join(e["data"]["delta"]["partial_json"] for e in events
                           if e["event"] == "content_block_delta"
                           and e["data"]["delta"]["type"] == "input_json_delta")
        self.assertEqual(partials, '{"a":1}')
        # 全部输入先于 message_stop，块都正确闭合
        self.assertEqual(_events_names(events)[-3:],
                         ["content_block_stop", "message_delta", "message_stop"])

    def test_aborted_no_fake_message_stop(self):
        t, events = _feed_chunks([{"choices": [{"delta": {"content": "半截"}}]}])
        err_events = t.aborted_error("upstream broken")
        all_events = events + err_events + ([] if True else [])
        names = _events_names(all_events)
        self.assertIn("error", names)
        self.assertNotIn("message_stop", names)   # 断流绝不伪装终态

    def test_empty_stream_flushes_to_nothing(self):
        t, events = _feed_chunks([])
        self.assertEqual(t.flush(), [])           # 上游没吐内容就不伪造半条消息


class TestSseFraming(unittest.TestCase):
    def test_frames(self):
        self.assertTrue(sse_frame({"event": "message", "data": {"a": 1}})
                        .startswith("data: "))
        frame = sse_frame({"event": "content_block_delta", "data": {"x": 1}})
        self.assertTrue(frame.startswith("event: content_block_delta\ndata: "))
        self.assertTrue(frame.endswith("\n\n"))


if __name__ == "__main__":
    unittest.main()
