#!/usr/bin/env python3
"""wf-profile: 解析 workflow transcript 目录,输出每 agent 的耗时/调用/token/上下文画像。

用法:
    python3 wf-profile.py <workflow-transcript-dir> [--agent <agentId>]

transcript 目录位于 session 目录下 subagents/workflows/wf_*/。每行一个 JSON 事件,
带 timestamp;message.content 里的 tool_use / tool_result 对应一轮调用。
"""

import argparse
import datetime
import json
import sys
from pathlib import Path


def parse_ts(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_events(path):
    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return [e for e in events if e.get("timestamp")]


def content_parts(msg):
    c = msg.get("message", {}).get("content")
    if isinstance(c, list):
        return c
    return []


def profile_agent(path):
    events = load_events(path)
    if not events:
        return None
    agent_id = events[0].get("agentId") or path.stem.removeprefix("agent-")

    calls = []          # (ts, tool_name, desc)
    result_sizes = []   # tool_result 累计字节(上下文近似)
    pending_call = None
    total_bytes = 0
    assistant_msgs = 0
    max_gap = (None, 0)  # (结束时刻, 秒) —— 单次模型侧停顿峰值

    for e in events:
        ts = parse_ts(e["timestamp"])
        role = e.get("message", {}).get("role") or e.get("type")
        for c in content_parts(e):
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                inp = c.get("input", {}) or {}
                desc = (inp.get("description") or inp.get("command")
                        or inp.get("file_path") or inp.get("pattern") or "")
                pending_call = (ts, c.get("name", "?"), str(desc)[:60])
            elif c.get("type") == "tool_result":
                size = len(json.dumps(c.get("content", ""), ensure_ascii=False))
                result_sizes.append(size)
                if pending_call:
                    calls.append(pending_call + (size,))
                    pending_call = None
        if role == "assistant":
            assistant_msgs += 1
        # 上下文近似:事件行本身累计字节
        total_bytes += len(json.dumps(e, ensure_ascii=False))

    # 逐轮模型侧间隔:上一 tool_result 之后到下一次 tool_use 之间的空档
    gaps = []
    prev_ts = None
    for e in events:
        ts = parse_ts(e["timestamp"])
        parts = content_parts(e)
        has_use = any(isinstance(c, dict) and c.get("type") == "tool_use" for c in parts)
        if prev_ts is not None and (has_use or parts):
            gaps.append((ts, (ts - prev_ts).total_seconds()))
        if parts:
            prev_ts = ts
    # 简化:取相邻事件最大间隔
    max_gap = max(
        ((events[i], (parse_ts(events[i + 1]["timestamp"]) - parse_ts(events[i]["timestamp"])).total_seconds())
         for i in range(len(events) - 1)),
        key=lambda x: x[1], default=(None, 0),
    )

    start, end = parse_ts(events[0]["timestamp"]), parse_ts(events[-1]["timestamp"])
    duration = (end - start).total_seconds()
    tool_counts = {}
    for _, name, _, _ in calls:
        tool_counts[name] = tool_counts.get(name, 0) + 1

    # 找文件类调用占比:描述里含 Locate/Find/Where/which/搜索特征
    locate_kw = ("locate", "find", "where", "which file", "search")
    locate_calls = sum(
        1 for _, name, desc, _ in calls
        if any(k in desc.lower() for k in locate_kw)
    )

    # 上下文增长曲线:按事件序号累计字节,输出 25/50/75/100% 时点
    running = []
    acc = 0
    for e in events:
        acc += len(json.dumps(e, ensure_ascii=False))
        running.append(acc)
    quarters = [running[min(int(len(running) * q / 4), len(running) - 1)] for q in (1, 2, 3, 4)]

    return {
        "agent": agent_id,
        "file": path.name,
        "start": start.strftime("%H:%M:%S"),
        "duration_s": duration,
        "events": len(events),
        "tool_calls": len(calls),
        "tool_breakdown": tool_counts,
        "locate_like_calls": locate_calls,
        "assistant_msgs": assistant_msgs,
        "transcript_kb": round(acc / 1024, 1),
        "result_bytes_top5": sorted(result_sizes, reverse=True)[:5],
        "context_quartiles_kb": [round(q / 1024, 1) for q in quarters],
        "max_event_gap_s": round(max_gap[1], 1),
        "max_gap_at": parse_ts(max_gap[0]["timestamp"]).strftime("%H:%M:%S") if max_gap[0] else "-",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path, help="workflow transcript 目录(wf_*)")
    ap.add_argument("--agent", help="只看单个 agent(前缀匹配)")
    args = ap.parse_args()

    files = sorted(args.dir.glob("agent-*.jsonl"))
    if args.agent:
        files = [f for f in files if args.agent in f.name]
    if not files:
        sys.exit(f"no agent-*.jsonl under {args.dir}")

    profiles = [p for p in (profile_agent(f) for f in files) if p]
    profiles.sort(key=lambda p: p["duration_s"], reverse=True)

    total_dur = sum(p["duration_s"] for p in profiles)
    total_calls = sum(p["tool_calls"] for p in profiles)
    print(f"{'agent':16} {'start':9} {'dur_s':>6} {'calls':>5} {'locate':>6} "
          f"{'kb':>7} {'maxgap':>7} {'maxgap@':9}")
    for p in profiles:
        print(f"{p['agent'][:16]:16} {p['start']:9} {p['duration_s']:6.0f} {p['tool_calls']:5} "
              f"{p['locate_like_calls']:6} {p['transcript_kb']:7.1f} {p['max_event_gap_s']:7.1f} {p['max_gap_at']:9}")
    print(f"\ntotal agent-time {total_dur:.0f}s, calls {total_calls}; "
          f"wall-clock 由最慢 agent 决定 = {profiles[0]['duration_s']:.0f}s")

    if args.agent:
        p = profiles[0]
        print(f"\n--- {p['agent']} 明细 ---")
        for k in ("tool_breakdown", "context_quartiles_kb", "result_bytes_top5"):
            print(f"{k}: {p[k]}")


if __name__ == "__main__":
    main()
