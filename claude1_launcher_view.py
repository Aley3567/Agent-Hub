"""Curses theme, brand animation and prepared-data panels for the claude1 TUI.

This module owns everything the launcher screens need in order to *look* like
claude1, and nothing about what they mean.  It never reads Hub configuration,
CC Switch rows, tokens or MRU state, never probes a Hub and never launches a
session; the launcher gathers those facts and hands the finished strings in.

Owner of three pieces of module state, and the only writer of all three:

- ``C`` — the colour palette, keyed by role (``"dim"``, ``"accent"``,
  ``"sel"`` …).  Read it with ``C.get(role, fallback)``: on a terminal without
  colour most roles stay ``0``, so every read needs a usable fallback.
- ``logo_pairs`` — the logo gradient, cycled per column/row/phase.
- ``row_pairs`` — the provider-row spectrum, cycled per list index.

``init_colors()`` rebuilds all three **in place** and is the only function that
writes them.  They are never rebound, so ``from claude1_launcher_view import
C`` stays valid for the life of the process; importers (and tests) must mutate,
never reassign.  Before ``init_colors()`` runs, ``C`` is empty and the pair
lists are empty — ``draw_logo``/``intro`` index into ``logo_pairs`` and require
at least one entry.

Error mode: curses raises rather than clips, so every curses call here is
guarded and degrades to a plain attribute (``0``) or a compact layout instead
of failing the screen.  ``curses`` is imported optionally so non-TUI launcher
commands keep working where it is unavailable.
"""

from __future__ import annotations

import os
import time

from claude1_terminal import (
    compose_row,
    display_width,
    pad_display,
    safe_addstr,
    truncate_display,
)

try:
    import curses
except ImportError:  # pragma: no cover - curses ships with CPython on macOS/Linux
    curses = None


# Shared theme state.  Rebuilt in place by init_colors(); never rebound.
C: dict = {}
logo_pairs: list[int] = []
row_pairs: list[int] = []

LOGO = [
    "  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗ ██╗",
    " ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝███║",
    " ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ╚██║",
    " ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝   ██║",
    " ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗ ██║",
    "  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝ ╚═╝",
]
LOGO_TOP = 2
LOGO_BREATH_LEVELS = (
    0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 0, 0,
)
INTRO_DURATION_SECONDS = 0.24
INTRO_FRAME_SECONDS = 0.016
INTRO_FLOW_STEP_SECONDS = 0.04
HUB_IDENTITY_COLORS = ("orange", "teal", "violet", "pink", "lime")

_LOGO_CELLS = [
    (row, column, char)
    for row, line in enumerate(LOGO)
    for column, char in enumerate(line)
    if char != " "
]
_HEADER_H = len(LOGO) + 6
_LOGO_MIN_LIST = 5
_MIN_TUI_ROWS = 8
_MIN_TUI_COLS = 32

# Logo and provider rows share a vivid full-spectrum identity.
_LOGO_GRAD = [
    196, 202, 208, 214, 220, 226, 190, 154, 118, 82, 46, 48,
    50, 51, 45, 39, 33, 63, 99, 135, 171, 207, 201, 199,
]
_RAINBOW = [203, 208, 214, 220, 148, 46, 42, 51, 45, 75, 99, 141, 207, 205]

_HUB_WIZARD_STAGES = ("渠道", "模型", "设置", "确认")


# ---------------------------------------------------------------------------
# Theme state — init_colors() is the only writer of C / logo_pairs / row_pairs
# ---------------------------------------------------------------------------


def init_colors() -> dict:
    """Rebuild the palette and both pair lists in place; return ``C``."""
    C.clear()
    C.update(
        {
            "dim": 0,
            "base": 0,
            "accent": 0,
            "warning": 0,
            "brand": 0,
            "sel": curses.A_REVERSE,
            "orange": 0,
            "pink": 0,
            "lime": 0,
            "gold": 0,
            "teal": 0,
            "violet": 0,
        }
    )
    logo_pairs.clear()
    row_pairs.clear()
    try:
        has_colors = curses.has_colors()
    except curses.error:
        has_colors = False
    if not has_colors:
        logo_pairs.append(0)
        row_pairs.extend([C["base"], C["accent"], C["brand"], C["warning"]])
        return C
    try:
        curses.start_color()
        curses.use_default_colors()
        bg = -1
    except curses.error:
        bg = 0

    def _pair(pid: int, fg: int, fallback: int = 0) -> int:
        max_pairs = int(getattr(curses, "COLOR_PAIRS", 0) or 0)
        if max_pairs and pid >= max_pairs:
            return fallback
        try:
            curses.init_pair(pid, fg, bg)
            return curses.color_pair(pid)
        except curses.error:
            return fallback

    cyan = _pair(1, curses.COLOR_CYAN)
    green = _pair(2, curses.COLOR_GREEN)
    yellow = _pair(3, curses.COLOR_YELLOW)
    magenta = _pair(4, curses.COLOR_MAGENTA)
    C.update(
        dim=curses.A_DIM,
        base=green,
        accent=cyan | curses.A_BOLD,
        warning=yellow,
        brand=magenta | curses.A_BOLD,
        sel=cyan | curses.A_REVERSE | curses.A_BOLD,
    )

    has256 = getattr(curses, "COLORS", 0) >= 256

    # Named vivid accents with safe basic-color fallbacks.
    C["orange"] = _pair(60, 208, C["warning"]) if has256 else C["warning"]
    C["pink"] = _pair(61, 205, C["brand"]) if has256 else C["brand"]
    C["lime"] = _pair(62, 118, C["base"]) if has256 else C["base"]
    C["gold"] = _pair(63, 220, C["warning"]) if has256 else C["warning"]
    C["teal"] = _pair(64, 44, C["accent"]) if has256 else C["accent"]
    C["violet"] = _pair(65, 141, C["brand"]) if has256 else C["brand"]

    # Selected row: bold black text on a vivid orange background.
    if has256:
        try:
            curses.init_pair(66, 16, 208)
            C["sel"] = curses.color_pair(66) | curses.A_BOLD
        except curses.error:
            pass

    # Rotate provider rows through a full spectrum; basic terminals keep
    # a compact four-color fallback.
    if has256:
        for i, cidx in enumerate(_RAINBOW):
            pair = _pair(40 + i, cidx, 0)
            if pair:
                row_pairs.append(pair)
    if not row_pairs:
        row_pairs.extend([C["base"], C["accent"], C["brand"], C["warning"]])

    if has256:
        for i, cidx in enumerate(_LOGO_GRAD):
            logo_pairs.append(_pair(10 + i, cidx, C["brand"]))
    if not logo_pairs:
        logo_pairs.extend([cyan, magenta])
    return C


def hub_identity_color(index: int) -> str:
    """Give each Hub / slot a stable palette role, wrapping on overflow."""
    return HUB_IDENTITY_COLORS[index % len(HUB_IDENTITY_COLORS)]


# ---------------------------------------------------------------------------
# Brand surface
# ---------------------------------------------------------------------------


def intro(win) -> int | None:
    """Animate for at most 240ms and return, rather than consume, any key."""
    rows, cols = win.getmaxyx()
    if not animation_enabled() or not large_logo_supported(rows, cols):
        return None
    win.erase()
    win.nodelay(True)
    n = len(logo_pairs) or 1
    width = max((len(line) for line in LOGO), default=0)
    started = time.monotonic()
    try:
        while True:
            elapsed = time.monotonic() - started
            if elapsed >= INTRO_DURATION_SECONDS:
                return None
            progress = min(1.0, elapsed / INTRO_DURATION_SECONDS)
            phase = int(elapsed / INTRO_FLOW_STEP_SECONDS)
            typed = min(
                len("欢迎回来"),
                max(1, int((elapsed / 0.12) * len("欢迎回来"))),
            )
            safe_addstr(
                win,
                0,
                2,
                pad_display("欢迎回来"[:typed], display_width("欢迎回来")),
                C.get("pink", 0) | curses.A_BOLD,
            )
            col = max(1, int(width * progress))
            for r, line in enumerate(LOGO):
                for x in range(min(col, len(line))):
                    chx = line[x]
                    if chx == " ":
                        continue
                    attr = (
                        logo_pairs[(x + r + phase) % n]
                        | logo_intensity(phase, True)
                    )
                    if x >= col - 2:
                        attr |= curses.A_REVERSE | curses.A_BOLD
                    safe_addstr(win, LOGO_TOP + r, 2 + x, chx, attr)
            win.refresh()
            key = win.getch()
            if key != -1:
                return key
            remaining = INTRO_DURATION_SECONDS - (time.monotonic() - started)
            if remaining > 0:
                time.sleep(min(INTRO_FRAME_SECONDS, remaining))
    finally:
        win.nodelay(False)


def draw_logo(
    win,
    phase: int,
    *,
    breathing: bool = False,
    force_compact: bool = False,
) -> None:
    """Flow the logo palette and optionally pulse its brightness."""
    n = len(logo_pairs) or 1
    h, w = win.getmaxyx()
    intensity = logo_intensity(phase, breathing)
    if not force_compact and large_logo_supported(h, w):
        limit = w - 1
        for row, column, char in _LOGO_CELLS:
            x = 2 + column
            if x >= limit:
                continue
            attr = logo_pairs[(column + row + phase) % n] | intensity
            try:
                win.addstr(LOGO_TOP + row, x, char, attr)
            except curses.error:
                pass
    else:
        safe_addstr(win, 0, 2, "◤ claude1 ◢", logo_pairs[phase % n] | intensity)


def logo_intensity(phase: int, breathing: bool) -> int:
    """Never dim the logo: breathing alternates bold and normal, not A_DIM."""
    if not breathing:
        return curses.A_BOLD
    level = LOGO_BREATH_LEVELS[phase % len(LOGO_BREATH_LEVELS)]
    if level > 0:
        return curses.A_BOLD
    return 0


# ---------------------------------------------------------------------------
# Panels — every argument is already-prepared text chosen by the launcher
# ---------------------------------------------------------------------------


def draw_provider_quick_panel(
    win,
    name: str,
    model: str,
    source: str,
    effort: str | None,
    notice: str | None,
) -> None:
    """模型/effort 快捷小面板；低行数终端省略面包屑与说明行。"""
    win.erase()
    h, w = win.getmaxyx()
    row_width = max(0, w - 4)
    row = 0
    if h >= 8:
        safe_addstr(win, row, 2, "Claude1  ›  模型 / effort", C.get("dim", 0))
        row = 2
    safe_addstr(
        win,
        row,
        2,
        truncate_display(name, row_width),
        C.get("lime", 0) | curses.A_BOLD,
    )
    row += 2 if h >= 8 else 1
    model_text = f"生效模型  {model}"
    if source:
        model_text += f"（{source}）"
    safe_addstr(
        win,
        row,
        2,
        truncate_display(model_text, row_width),
        C.get("base", 0),
    )
    row += 1
    effort_text = f"effort    {effort or '未设置（跟随默认）'}"
    safe_addstr(
        win,
        row,
        2,
        truncate_display(effort_text, row_width),
        C.get("accent", 0) | curses.A_BOLD,
    )
    if h >= 10:
        safe_addstr(
            win,
            row + 2,
            2,
            truncate_display(
                "覆盖只影响 claude1 启动的本次会话，不修改 CC Switch 配置",
                row_width,
            ),
            C.get("dim", 0),
        )
    footer = notice or "m/Enter 编辑模型（留空清除） · ←/→/e 切换 effort · Esc 保存返回"
    safe_addstr(
        win,
        max(0, h - 1),
        2,
        truncate_display(footer, row_width),
        C.get("warning", 0) if notice else C.get("dim", 0),
    )
    win.refresh()


def draw_hub_wizard_shell(
    win,
    stage: int,
    title: str,
    *,
    detail: str = "",
    footer: str = "Esc 取消 · ↑↓/jk 选择 · Enter 继续",
) -> int:
    """Draw the shared four-stage add-channel surface and return its list top."""
    win.erase()
    h, w = win.getmaxyx()
    width = max(0, w - 4)
    safe_addstr(
        win,
        0,
        2,
        truncate_display("Claude1  ›  Claude-Hub  ›  新增 Hub 渠道", width),
        C.get("dim", 0),
    )
    compact = h < 10
    progress_row = 1 if compact else 2
    title_row = 2 if compact else 4
    progress_x = 2
    for index, label in enumerate(_HUB_WIZARD_STAGES):
        marker = "✓" if index < stage else "●" if index == stage else "○"
        token = f"{marker} {label}"
        if index < stage:
            attr = C.get("lime", 0)
        elif index == stage:
            attr = C.get("orange", C.get("accent", 0)) | curses.A_BOLD
        else:
            attr = C.get("dim", 0)
        safe_addstr(win, progress_row, progress_x, token, attr)
        progress_x += display_width(token)
        if index < len(_HUB_WIZARD_STAGES) - 1:
            separator = "  ─  "
            safe_addstr(win, progress_row, progress_x, separator, C.get("dim", 0))
            progress_x += display_width(separator)
    safe_addstr(
        win,
        title_row,
        2,
        truncate_display(title, width),
        C.get("accent", 0) | curses.A_BOLD,
    )
    if detail and h >= 8:
        safe_addstr(
            win,
            title_row + 1,
            2,
            truncate_display(detail, width),
            C.get("dim", 0),
        )
    safe_addstr(
        win,
        max(0, h - 1),
        2,
        truncate_display(footer, width),
        C.get("dim", 0),
    )
    if not compact:
        return 7
    return 4 if h >= 8 else 3


def draw_hub_wizard_options(
    win,
    options: list[tuple[str, str]],
    idx: int,
    list_top: int,
    color_keys: list[str] | None = None,
) -> None:
    """Render one selectable option list inside the add-channel surface."""
    h, w = win.getmaxyx()
    row_width = max(0, w - 4)
    capacity = max(1, h - 1 - list_top)
    start, end = visible_window(len(options), idx, capacity)
    for offset, option_index in enumerate(range(start, end)):
        primary, secondary = options[option_index]
        selected = option_index == idx
        marker = "▸" if selected else " "
        line = marker + " " + compose_row(
            primary,
            secondary,
            max(0, row_width - 2),
        )
        if color_keys and option_index < len(color_keys):
            row_attr = C.get(color_keys[option_index], 0)
        elif row_pairs:
            row_attr = row_pairs[option_index % len(row_pairs)]
        else:
            row_attr = C.get("base", 0)
        safe_addstr(
            win,
            list_top + offset,
            2,
            pad_display(line, row_width) if selected else line,
            C.get("sel", curses.A_REVERSE)
            if selected
            else row_attr | curses.A_BOLD,
        )


# ---------------------------------------------------------------------------
# Terminal capability gates and list geometry
# ---------------------------------------------------------------------------


def tui_size_supported(rows: int, cols: int) -> bool:
    """Below this the launcher falls back to plain text instead of curses."""
    return rows >= _MIN_TUI_ROWS and cols >= _MIN_TUI_COLS


def large_logo_supported(rows: int, cols: int) -> bool:
    """The full ASCII logo needs its own width plus room for a usable list."""
    logo_width = max((display_width(line) for line in LOGO), default=0)
    return cols >= logo_width + 4 and rows > _HEADER_H + _LOGO_MIN_LIST


def animation_enabled() -> bool:
    """``CLAUDE1_NO_ANIMATION`` is a display preference, not Hub configuration."""
    disabled = os.environ.get("CLAUDE1_NO_ANIMATION", "").strip().casefold()
    return disabled not in {"1", "true", "yes", "on"}


def visible_window(total: int, selected: int, capacity: int) -> tuple[int, int]:
    """Scroll a list so the selected row sits mid-window where possible."""
    if total <= 0 or capacity <= 0:
        return (0, 0)
    capacity = min(total, capacity)
    start = max(0, min(selected - (capacity // 2), total - capacity))
    return (start, start + capacity)


def safe_curs_set(visibility: int) -> None:
    """Some terminals reject cursor visibility changes; ignore the refusal."""
    try:
        curses.curs_set(visibility)
    except (AttributeError, curses.error):
        pass
