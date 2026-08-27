#!/usr/bin/env python3
"""wf-eval: 对照 golden set 评估一次 commit 分析 workflow run 的四指标。

用法:
    python3 wf-eval.py <workflow-output.json> <golden-set.json>

workflow-output.json: Workflow 任务完成通知对应的 tasks/*.output 文件,需含
    result.by_commit[].issues 与 workflowProgress[](agent startedAt/durationMs)与 totalTokens。
golden-set.json: [
  {"id": 1, "hash": "...", "file": "...", "verdict": "confirmed",
   "match": ["pending", "脱敏"],          # 关键词:run 报告命中任一即算召回
   "severity": "medium"}
]
只有 verdict=confirmed 的条目计入召回分母;refuted 条目用于反向核查——若 run 又把它
报成 medium+,计为精度扣分项。

目标线见 GOALS(召回优先档,2026-08-27 放宽过一次)。
"""

import json
import sys
from pathlib import Path

# 目标线(召回优先档,2026-08-27 放宽:原 480s/400k 在此上游与召回 100% 冲突,见 v4/v5 对比)
GOALS = {"recall": 1.0, "precision": 0.8, "wall_s": 720, "tokens": 650_000}


def load(path):
    return json.loads(Path(path).read_text())


def normalize_hash(h):
    return h[:7]


def wall_clock(output):
    """workflowProgress 的 startedAt(ms)+durationMs → 整体墙钟(首启到最晚结束)。"""
    spans = []
    for a in output.get("workflowProgress", []):
        if "startedAt" not in a or "durationMs" not in a:
            continue
        spans.append((a["startedAt"], a["startedAt"] + a["durationMs"]))
    if not spans:
        return None
    return (max(e for _, e in spans) - min(s for s, _ in spans)) / 1000


def collect_reported_issues(output):
    """run 报出的全部 issue,平铺为 {hash, severity, file, description}。

    兼容两种输出形状:v1 的 result.results[] 与 v2/v3 的 result.by_commit[]。
    """
    result = output.get("result", {})
    containers = result.get("by_commit") or result.get("results") or []
    issues = []
    for c in containers:
        for iss in c.get("issues", c.get("correctness_issues", [])):
            issues.append({
                "hash": normalize_hash(c["hash"]),
                "severity": iss.get("severity"),
                "file": iss.get("file"),
                "description": iss.get("description", ""),
            })
    return issues


def hit(iss, entry):
    """issue 与 golden 条目匹配:同 commit 必须满足;有 match 关键词时按关键词匹配
    (同一发现在不同轮次可能定位到症状文件而非根因文件,file 形态不稳定),
    无关键词时回退到文件后缀匹配。"""
    if normalize_hash(entry["hash"]) != iss["hash"]:
        return False
    kws = entry.get("match")
    if kws:
        text = iss["description"]
        return any(k in text for k in kws)
    if entry.get("file"):
        return (iss.get("file") or "").endswith(entry["file"])
    return True


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    output = load(sys.argv[1])
    golden = load(sys.argv[2])

    reported = collect_reported_issues(output)
    true_findings = [g for g in golden if g["verdict"] == "confirmed"]
    false_findings = [g for g in golden if g["verdict"] == "refuted"]

    # 召回:真发现被任一 issue 命中
    recalled = [g for g in true_findings if any(hit(i, g) for i in reported)]
    missed = [g for g in true_findings if g not in recalled]
    recall = len(recalled) / len(true_findings) if true_findings else None

    # 精度:medium+ 报告中,命中真发现的比例(refuted 条目再现即计误报)
    reported_med = [i for i in reported if i["severity"] in ("medium", "high")]
    true_pos = [i for i in reported_med if any(hit(i, g) for g in true_findings)]
    known_fp = [i for i in reported_med if any(hit(i, g) for g in false_findings)]
    unknown = [i for i in reported_med
               if i not in true_pos and i not in known_fp]
    precision = len(true_pos) / len(reported_med) if reported_med else None

    wall = wall_clock(output)
    tokens = output.get("totalTokens")

    print(f"召回: {len(recalled)}/{len(true_findings)}"
          f"{' = %.0f%%' % (recall * 100) if recall is not None else ''}"
          f"  [目标 100%]")
    for g in missed:
        print(f"  漏检: #{g['id']} {g['file']} — {g.get('note', '')}")
    print(f"精度: {len(true_pos)}/{len(reported_med)}"
          f"{' = %.0f%%' % (precision * 100) if precision is not None else ''}"
          f"  [目标 ≥80%]")
    for i in known_fp:
        print(f"  已知误报再现: {i['hash']} {i['file']} — {i['description'][:60]}")
    for i in unknown:
        print(f"  未判定(golden set 外): {i['hash']} {i['file']} — {i['description'][:60]}")
    print(f"墙钟: {wall:.0f}s  [目标 ≤{GOALS['wall_s']}s]" if wall else "墙钟: n/a")
    print(f"token: {tokens}  [目标 ≤{GOALS['tokens']}]" if tokens else "token: n/a")

    checks = [
        recall is not None and recall >= GOALS["recall"],
        precision is not None and precision >= GOALS["precision"],
        wall is not None and wall <= GOALS["wall_s"],
        tokens is not None and tokens <= GOALS["tokens"],
    ]
    verdict = "达标" if all(checks) else "未达标: " + ", ".join(
        n for n, ok in zip(("召回", "精度", "墙钟", "token"), checks) if not ok)
    print(f"\n判定: {verdict}")
    sys.exit(0 if all(checks) else 1)


if __name__ == "__main__":
    main()
