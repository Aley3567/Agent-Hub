#!/usr/bin/env python3
"""Re-extract the 1M context matrix from the installed Claude Code binary.

``claude1_context_window.CONTEXT_MATRIX`` mirrors a ``context:{...}`` table that
ships inside the Claude Code executable.  That table is the only authoritative
statement of which models reach 1M and how, so this script exists to re-derive
it instead of trusting prose or memory:

    python3 tools/extract_1m_matrix.py --check   # CI/doctor: does the constant still match?
    python3 tools/extract_1m_matrix.py --emit    # print a paste-ready constant

The parse is deliberately shape-specific.  A future CLI build may minify the
table differently; when that happens ``--check`` reports "解析不到模型表" rather
than silently producing an empty matrix that would look like agreement.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from claude1_context_window import (  # noqa: E402  (path set above)
    CONTEXT_MATRIX,
    MATRIX_CLI_VERSION,
    ModelContext,
)

_ENTRY_RE = re.compile(rb'\{id:"([A-Za-z0-9._-]+)",family:"([a-z0-9]+)"')
_CONTEXT_RE = re.compile(rb"context:\{window:")
_WINDOW_RE = re.compile(rb"window:([0-9e.+]+)")
# Anything up to the matching close brace, so nested objects such as
# ``native_1m_3p:{bedrock:!0,...}`` do not truncate the block.
_MAX_BLOCK = 800
_MAX_LOOKBEHIND = 1500


def resolve_claude_bin() -> Path | None:
    """Mirror the launcher's resolution order without importing it."""
    override = os.environ.get("CLAUDE1_CLAUDE_BIN")
    if override:
        candidate = Path(override).expanduser()
        return candidate if candidate.exists() else None
    found = shutil.which("claude")
    if found:
        return Path(found).resolve()
    default = Path.home() / ".local" / "bin" / "claude"
    return default if default.exists() else None


def cli_version(binary: Path) -> str | None:
    """Read the version from the npm package that owns the executable."""
    for parent in binary.resolve().parents:
        manifest = parent / "package.json"
        if not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if data.get("name") == "@anthropic-ai/claude-code":
            version = data.get("version")
            return version if isinstance(version, str) else None
    return None


def _balanced(data: bytes, open_index: int) -> bytes:
    depth = 0
    limit = min(len(data), open_index + _MAX_BLOCK)
    for index in range(open_index, limit):
        char = data[index : index + 1]
        if char == b"{":
            depth += 1
        elif char == b"}":
            depth -= 1
            if depth == 0:
                return data[open_index : index + 1]
    return b""


def _flag(block: bytes, name: str) -> bool:
    return re.search(rb"\b" + name.encode() + rb":!0", block) is not None


def extract(binary: Path) -> dict[str, ModelContext]:
    data = binary.read_bytes()
    matrix: dict[str, ModelContext] = {}
    for match in _CONTEXT_RE.finditer(data):
        brace = match.end() - len(b"window:") - 1
        block = _balanced(data, brace)
        if not block:
            continue
        window_match = _WINDOW_RE.search(block)
        if window_match is None:
            continue
        behind = data[max(0, match.start() - _MAX_LOOKBEHIND) : match.start()]
        ids = _ENTRY_RE.findall(behind)
        if not ids:
            continue
        model_id = ids[-1][0].decode()
        window = int(float(window_match.group(1).decode()))
        matrix.setdefault(
            model_id.casefold(),
            ModelContext(
                window=window,
                native_1m=_flag(block, "native_1m"),
                supports_1m_beta=_flag(block, "supports_1m_beta"),
                supports_1m_suffix=_flag(block, "supports_1m_suffix"),
                native_1m_3p=b"native_1m_3p" in block,
            ),
        )
    return matrix


def emit(matrix: dict[str, ModelContext], version: str | None) -> str:
    lines = [
        f'MATRIX_CLI_VERSION = "{version or "unknown"}"',
        "",
        "CONTEXT_MATRIX: dict[str, ModelContext] = {",
    ]
    for model_id, entry in matrix.items():
        flags = []
        if entry.native_1m:
            flags.append("native_1m=True")
        if entry.supports_1m_beta:
            flags.append("supports_1m_beta=True")
        if entry.supports_1m_suffix:
            flags.append("supports_1m_suffix=True")
        if entry.native_1m_3p:
            flags.append("native_1m_3p=True")
        window = "ONE_M" if entry.window == 1_000_000 else f"{entry.window:_}"
        joined = ", ".join([window, *flags])
        lines.append(f'    "{model_id}": ModelContext({joined}),')
    lines.append("}")
    return "\n".join(lines)


def diff(live: dict[str, ModelContext]) -> list[str]:
    problems: list[str] = []
    for model_id in sorted(set(live) | set(CONTEXT_MATRIX)):
        want = CONTEXT_MATRIX.get(model_id)
        got = live.get(model_id)
        if want is None:
            problems.append(f"新增模型 {model_id}: {got}")
        elif got is None:
            problems.append(f"二进制中已无 {model_id}（内嵌矩阵仍保留）")
        elif want != got:
            problems.append(f"{model_id} 已变化: 内嵌={want} 实际={got}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="比对内嵌矩阵与实际二进制，不一致时退出码为 1",
    )
    mode.add_argument(
        "--emit", action="store_true", help="打印可直接粘贴的 Python 常量"
    )
    parser.add_argument("--binary", help="显式指定 Claude Code 可执行文件")
    args = parser.parse_args(argv)

    binary = Path(args.binary).expanduser() if args.binary else resolve_claude_bin()
    if binary is None or not binary.exists():
        print("未找到 Claude Code 可执行文件；用 --binary 指定", file=sys.stderr)
        return 2

    version = cli_version(binary)
    live = extract(binary)
    if not live:
        print(
            f"在 {binary} 中解析不到模型表；CLI 的压缩形状可能已变，"
            "需要更新本脚本的正则",
            file=sys.stderr,
        )
        return 2

    if args.emit:
        print(emit(live, version))
        return 0

    problems = diff(live)
    stale_version = version is not None and version != MATRIX_CLI_VERSION
    print(f"Claude Code {version or '版本未知'} · 解析到 {len(live)} 个模型")
    if stale_version:
        print(f"  内嵌矩阵提取自 v{MATRIX_CLI_VERSION}")
    if not problems:
        print("  矩阵一致" + ("（仅版本号需更新）" if stale_version else ""))
        return 1 if stale_version and args.check else 0
    for line in problems:
        print(f"  {line}")
    return 1 if args.check else 0


if __name__ == "__main__":
    raise SystemExit(main())
