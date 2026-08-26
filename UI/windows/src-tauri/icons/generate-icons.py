#!/usr/bin/env python3
"""Agent Hub 应用图标生成器（Windows 工程）。

输入固定为仓库根目录的 assets/brand/agent-hub/mark.svg（青→紫渐变折纸 A）。
本脚本优先使用系统已安装的渲染器把 SVG 转成各尺寸 PNG，再用 Python 标准库打包
icon.ico；macOS 上还会用 iconutil 额外生成 icon.icns，方便两侧文件同步。

用法（在本目录下执行）：

    python3 generate-icons.py

产出 32x32.png / 128x128.png / 128x128@2x.png / icon.png / icon.ico。
在 macOS 上同时产出 icon.icns。
"""

from __future__ import annotations

import pathlib
import platform
import shutil
import struct
import subprocess
import sys
import tempfile

# 仓库根目录（本文件在 UI/windows/src-tauri/icons/，向上四级到仓库根）
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


def find_renderer() -> list[str] | None:
    """找一个能把 SVG 渲染成 PNG 的命令行工具。"""
    system = platform.system()
    if system == "Darwin" and shutil.which("sips"):
        return ["sips"]
    for tool in ("magick", "inkscape", "rsvg-convert"):
        if shutil.which(tool):
            return [tool]
    try:
        import cairosvg  # type: ignore[import-untyped]
        return ["cairosvg"]
    except ImportError:
        pass
    return None


def render_with(tool: list[str], size: int, svg: pathlib.Path, out: pathlib.Path) -> None:
    name = tool[0]
    if name == "sips":
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "mark-256.png"
            subprocess.run(["sips", "-s", "format", "png", str(svg), "--out", str(base)], check=True)
            if size == 256:
                out.write_bytes(base.read_bytes())
            else:
                subprocess.run(["sips", "-Z", str(size), str(base), "--out", str(out)], check=True)
        return
    if name == "magick":
        subprocess.run(["magick", str(svg), "-resize", f"{size}x{size}", str(out)], check=True)
        return
    if name == "inkscape":
        subprocess.run(
            ["inkscape", "--export-type=png", f"--export-width={size}", f"--export-height={size}",
             f"--export-filename={out}", str(svg)],
            check=True,
        )
        return
    if name == "rsvg-convert":
        subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(out), str(svg)], check=True)
        return
    if name == "cairosvg":
        import cairosvg  # type: ignore[import-untyped]
        cairosvg.svg2png(url=str(svg), write_to=str(out), output_width=size, output_height=size)
        return
    raise RuntimeError(f"不支持的渲染工具：{name}")


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

    renderer = find_renderer()
    if renderer is None:
        print(
            "找不到 SVG 渲染工具。请在 Windows 上安装 ImageMagick、Inkscape 或 cairosvg，"
            "或者从 macOS 侧运行 generate-icons.py 后将同名文件同步到本目录。",
            file=sys.stderr,
        )
        return 1

    out_dir = pathlib.Path(__file__).resolve().parent

    rendered: dict[int, bytes] = {}
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        for size in SIZES:
            print(f"渲染 {size}x{size} …", flush=True)
            png_path = tmp_path / f"{size}.png"
            render_with(renderer, size, MARK_SVG, png_path)
            rendered[size] = png_path.read_bytes()

        for name, size in BUNDLE_PNGS.items():
            (out_dir / name).write_bytes(rendered[size])
            print(f"写出 {name}")

        build_ico(rendered, out_dir / "icon.ico")
        print("写出 icon.ico（" + "、".join(f"{s}px" for s in ICO_SIZES) + "）")

        if platform.system() == "Darwin" and shutil.which("iconutil"):
            iconset = tmp_path / "agent-hub.iconset"
            iconset.mkdir()
            for name, size in ICONSET_MAP.items():
                (iconset / name).write_bytes(rendered[size])
            subprocess.run(
                ["iconutil", "-c", "icns", str(iconset), "-o", str(out_dir / "icon.icns")],
                check=True,
            )
            print("写出 icon.icns")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
