#!/usr/bin/env python3
"""Agent Hub 应用图标生成器。

输入固定为仓库根目录的 assets/brand/agent-hub/mark.svg（青→紫渐变折纸 A）。
macOS 上用 sips 渲染/缩放，再用 iconutil 合成 icon.icns；同时用 Python 标准库
打包 PNG 数据生成 Windows 用的 icon.ico，实现同名文件同步。

用法（在本目录下执行）：

    python3 generate-icons.py

产出 32x32.png / 128x128.png / 128x128@2x.png / icon.png / icon.icns，
以及同步到 Windows 工程的 icon.ico（多尺寸 PNG 编码）。
"""

from __future__ import annotations

import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile

# 仓库根目录（本文件在 UI/macos/src-tauri/icons/，向上四级到仓库根）
REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
MARK_SVG = REPO_ROOT / "assets" / "brand" / "agent-hub" / "mark.svg"

SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)

# tauri.conf.json 的 bundle.icon 列表 → 像素尺寸
BUNDLE_PNGS = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 1024,
}

# iconutil 认的文件名 → 像素尺寸
ICONSET_MAP = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}

# Windows icon.ico 里放的档位
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def run_sips(args: list[str]) -> None:
    result = subprocess.run(["sips"] + args, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr or result.stdout, file=sys.stderr)
        raise SystemExit(result.returncode)


def render_mark(size: int, out: pathlib.Path) -> None:
    """把 mark.svg 渲染成 size×size 的 PNG。

    sips 直接从 SVG 缩放输出指定尺寸不可靠，先转成 256×256 的临时 PNG，
    再用 -Z 得到目标尺寸（保持宽高比，按长边适配）。
    """
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / "mark-256.png"
        run_sips(["-s", "format", "png", str(MARK_SVG), "--out", str(base)])
        if size == 256:
            out.write_bytes(base.read_bytes())
        else:
            run_sips(["-Z", str(size), str(base), "--out", str(out)])


def build_ico(rendered: dict[int, bytes], out: pathlib.Path) -> None:
    """把各尺寸 PNG 打包成 Windows icon.ico（所有尺寸都用 PNG 编码）。"""
    payloads = [(size, rendered[size]) for size in ICO_SIZES]
    offset = 6 + 16 * len(payloads)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(payloads)))
    for size, payload in payloads:
        side = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
    out.write_bytes(bytes(directory) + b"".join(payload for _, payload in payloads))


def main() -> int:
    if not MARK_SVG.exists():
        print(f"找不到品牌 SVG：{MARK_SVG}", file=sys.stderr)
        return 1

    if shutil.which("sips") is None:
        print("找不到 sips，无法从 SVG 渲染图标（需要 macOS）", file=sys.stderr)
        return 1

    out_dir = pathlib.Path(__file__).resolve().parent

    rendered: dict[int, bytes] = {}
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        for size in SIZES:
            print(f"渲染 {size}x{size} …", flush=True)
            png_path = tmp_path / f"{size}.png"
            render_mark(size, png_path)
            rendered[size] = png_path.read_bytes()

        for name, size in BUNDLE_PNGS.items():
            (out_dir / name).write_bytes(rendered[size])
            print(f"写出 {name}")

        if shutil.which("iconutil") is None:
            print("找不到 iconutil，无法合成 icon.icns（需要 macOS）", file=sys.stderr)
            return 1

        iconset = tmp_path / "agent-hub.iconset"
        iconset.mkdir()
        for name, size in ICONSET_MAP.items():
            (iconset / name).write_bytes(rendered[size])
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(out_dir / "icon.icns")],
            check=True,
        )
        print("写出 icon.icns")

    build_ico(rendered, out_dir / "icon.ico")
    print("写出 icon.ico（" + "、".join(f"{s}px" for s in ICO_SIZES) + "）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
