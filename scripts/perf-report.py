#!/usr/bin/env python3
"""claude-hub 速度画像分析器：把 usage/errors JSONL 聚成 TPS、时延、成功率。

数据来源是 hub 运行副本落盘的两份 JSONL（路径可用环境变量覆盖处的默认值）：

  claude-hub-usage.jsonl   每个完成请求一行；2026-08-27 后携带
                           ``ttft_ms``/``stream_ms``/``chunks``/``upstream_bytes``
                           （需 hub 已部署带 stream_metrics 的版本）。
  claude-hub-errors.jsonl  每个异常终局 attempt 一行。``deg`` 含
                           HUB_DEGRADE_STREAM_REPLAYED 的行表示 hub 已无声换
                           attempt 重放吸收、客户端无感——单独归类为 internal，
                           不计入用户可见失败。

三项指标口径：
  成功率   visible = 完成 /（完成 + 可见失败）；另给上游健康度 = 完成/(完成+全部异常)
  时延     stream_ms 分布 p50/p95；TTFT 取 ttft_ms p50/p90
  TPS      每请求 out_tokens ÷ stream 秒取中位数；另给加权吞吐 sum(out)/sum(stream秒)

只依赖标准库。统计脚本绝不修改原始 JSONL。
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

HOME = Path.home()
DEFAULT_USAGE = HOME / ".cc-switch" / "logs" / "claude-hub-usage.jsonl"
DEFAULT_ERRORS = HOME / ".cc-switch" / "logs" / "claude-hub-errors.jsonl"
REPLAYED = "HUB_DEGRADE_STREAM_REPLAYED"
# TTFT 档位边界（输入 token 数）：档位间中位数差距远小于输入比例 ⇒ 缓存真实生效。
CACHE_PROBE_EDGES = (5_000, 20_000, 80_000)


def _rows(path: Path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _percentile(values, q):
    """线性插值百分位；空序列返回 None。"""
    if not values:
        return None
    ordered = sorted(values)
    idx = min(int(len(ordered) * q), len(ordered) - 1)
    return ordered[idx]


def _fmt_pair(pair, unit=""):
    lo, hi = pair
    if lo is None:
        return "-"
    return f"{lo:,.0f}/{hi:,.0f}{unit}"


def _tps(out_tokens, stream_ms):
    if not stream_ms or stream_ms <= 0:
        return None
    return out_tokens / (stream_ms / 1000)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--usage", type=Path, default=DEFAULT_USAGE)
    parser.add_argument("--errors", type=Path, default=DEFAULT_ERRORS)
    parser.add_argument(
        "--since", default="00:00", help="起始时刻 HH:MM（今天），或 YYYY-MM-DDTHH:MM"
        ""
    )
    parser.add_argument("--hours", type=float, default=24.0, help="回看时长")
    parser.add_argument("--window", type=int, default=30, help="聚合窗宽（分钟）")
    parser.add_argument("--channel")
    parser.add_argument("--model")
    args = parser.parse_args()

    since_raw = args.since
    try:
        start = datetime.now().replace(
            hour=int(since_raw.split(":")[0]),
            minute=int(since_raw.split(":")[1]) if ":" in since_raw else 0,
            second=0,
            microsecond=0,
        )
    except ValueError:
        start = datetime.fromisoformat(since_raw)
    end = start + timedelta(hours=args.hours)

    def in_window(row):
        t = datetime.fromtimestamp(row.get("ts", 0))
        return start <= t < end

    def wanted(row):
        for key, needle in (("channel", args.channel), ("model", args.model)):
            if needle and str(row.get(key) or "").lower().find(needle.lower()) < 0:
                return False
        return True

    usage_rows = [
        r for r in _rows(args.usage) if in_window(r) and wanted(r)
    ]
    err_rows = [
        r for r in _rows(args.errors) if in_window(r) and wanted(r)
    ]
    if not usage_rows and not err_rows:
        print(f"{start:%m-%d %H:%M} 起 {args.hours:g}h 内无匹配记录（筛选条件："
              f"channel={args.channel} model={args.model}）")
        return 0

    # ---- 三类计数：完成 / 内部重放吸收 / 用户可见失败 -------------------
    done = len(usage_rows)
    replayed = sum(1 for e in err_rows if REPLAYED in (e.get("deg") or []))
    visible_fail = len(err_rows) - replayed
    total_upstream_tries = done + len(err_rows)

    stream_done = [r for r in usage_rows if r.get("stream_ms")]
    ttfts = [r["ttft_ms"] for r in stream_done if r.get("ttft_ms")]
    durs = [r["stream_ms"] for r in stream_done]
    tpss = [
        t
        for t in (_tps(r.get("out") or 0, r.get("stream_ms")) for r in stream_done)
        if t is not None
    ]
    weighted_tps = (
        sum(r.get("out") or 0 for r in stream_done)
        / (sum(durs) / 1000)
        if durs and sum(durs) > 0
        else None
    )

    print(f"== {start:%Y-%m-%d %H:%M} 起 {args.hours:g}h · "
          f"channel={args.channel or '任意'} model={args.model or '任意'} ==")
    if total_upstream_tries == 0:
        print("无上游尝试记录")
        return 0
    print(f"完成 {done} · 可见失败 {visible_fail} · 内部重放吸收 {replayed}")
    print(f"成功率(用户可见) {done / (done + visible_fail):6.1%}"
          f" · 上游健康度 {done / total_upstream_tries:6.1%}")
    timed = len(stream_done)
    if timed:
        print(f"已计时流式请求 {timed}/{done}"
              f"（不足说明该时段由旧版 hub 记录或存在非流式响应）\n")
        print(f"TTFT   p50/p90   {_fmt_pair((_percentile(ttfts,.5), _percentile(ttfts,.9)), 'ms')}")
        print(f"时长   p50/p95   {_fmt_pair((_percentile(durs,.5), _percentile(durs,.95)), 'ms')}")
        med_tps = statistics.median(tpss) if tpss else None
        med = f"{med_tps:.1f}" if med_tps is not None else "-"
        wt = f"{weighted_tps:.1f}" if weighted_tps is not None else "-"
        print(f"TPS    中位      {med} tok/s · 加权吞吐 {wt} tok/s\n")
    else:
        print("本时段无携带计时的请求行（速度指标需新版 hub 落盘后产生数据）\n")

    # ---- 时间窗表 -------------------------------------------------------
    width = max(args.window, 1)
    buckets = defaultdict(lambda: {"done": [], "fail": 0})
    for r in usage_rows:
        t = datetime.fromtimestamp(r["ts"])
        key = t.replace(minute=t.minute // width * width, second=0, microsecond=0)
        buckets[key]["done"].append(r)
    for r in err_rows:
        if REPLAYED in (r.get("deg") or []):
            continue
        t = datetime.fromtimestamp(r["ts"])
        key = t.replace(minute=t.minute // width * width, second=0, microsecond=0)
        buckets[key]["fail"] += 1

    print(f"{'窗口':<17}{'完成':>5}{'败':>4}{'率':>7}"
          f"{'TTFT p50/p90':>16}{'时长p50/p95':>14}{'TPS中位':>10}{'out':>9}")
    for key in sorted(buckets):
        b = buckets[key]
        rows = b["done"]
        d_i = [r["ttft_ms"] for r in rows if r.get("ttft_ms")]
        d_d = [r["stream_ms"] for r in rows if r.get("stream_ms")]
        d_t = [
            x
            for x in (_tps(r.get("out") or 0, r.get("stream_ms")) for r in rows)
            if x is not None
        ]
        rate = f"{len(rows)/(len(rows)+b['fail']):.0%}"
        med_tps = f"{statistics.median(d_t):>8.1f}" if d_t else "       -"
        print(f"{key:%H:%M}-{key+timedelta(minutes=width):%H:%M}   "
              f"{len(rows):>5}{b['fail']:>4}{rate:>7}"
              f"{_fmt_pair((_percentile(d_i,.5), _percentile(d_i,.9)),'ms'):>16}"
              f"{_fmt_pair((_percentile(d_d,.5), _percentile(d_d,.95)),'ms'):>14}"
              f"{med_tps:>10}{sum(r.get('out') or 0 for r in rows):>9}")

    # ---- 缓存真实性探针 --------------------------------------------------
    cached = [r for r in stream_done if r.get("cr")]
    probe_rows = [(r.get("in") or 0, r["ttft_ms"]) for r in stream_done if r.get("ttft_ms")]
    if len(probe_rows) >= 10:
        edges = CACHE_PROBE_EDGES
        groups = defaultdict(list)
        for i, ms in probe_rows:
            groups[sum(i > e for e in edges)].append(ms)
        print("\n缓存真实性探针（TTFT 中位 × 输入规模档）")
        labels = ["≤5k"] + [f">{a//1000}k" for a in edges]
        base_med = None
        for gi, label in enumerate(labels):
            vals = groups.get(gi)
            if not vals:
                continue
            med = _percentile(vals, .5)
            if base_med is None:
                base_med = med
            ratio = f"（×{med/base_med:.1f} 基准档）" if base_med else ""
            print(f"  in {label:<6} ttft中位 {med:>7,.0f}ms  n={len(vals)}  {ratio}")
        print("判读：TTFT 若随输入档位接近线性放大 ⇒ 大前缀未命中缓存；"
              "各档持平 ⇒ 缓存真实生效（以同渠道同上游对比为准）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
