"""Terminal text metrics and window-safe drawing for the claude1 TUI.

The launcher renders Chinese provider names, aliases and status badges into a
fixed-size curses window.  Two facts drive everything here: a character's
display width is not its length (CJK and fullwidth forms take two columns,
combining marks and control characters take none), and curses raises rather
than clips when a write runs past the window edge.  Every helper in this file
answers one of those two problems in display columns, never in ``len()``.

Invariants callers may rely on:

- Every returned string measures at most the requested width in display
  columns, and never ends on the first half of a wide character.
- ``safe_addstr`` never raises and never writes outside the window: an
  off-screen row or column is dropped, a negative column scrolls the text left
  by that many columns, and the tail is clipped one column short of the right
  edge (curses treats a write into the last cell as an error).

Owner: this module owns terminal width arithmetic.  It holds no state, reads
no configuration, and knows nothing about providers, Hubs or key handling; the
caller decides what to draw and where.  ``curses`` is imported optionally so
that non-TUI launcher commands keep working where it is unavailable.
"""

from __future__ import annotations

import unicodedata

try:
    import curses
except ImportError:  # pragma: no cover - curses ships with CPython on macOS/Linux
    curses = None


def safe_addstr(win, y, x, text, attr=0) -> None:
    """Write ``text`` at ``(y, x)``, clipped to the window instead of raising."""
    h, w = win.getmaxyx()
    if y < 0 or y >= h or x >= w:
        return
    if x < 0:
        text = _drop_display_prefix(text, -x)
        x = 0
    text = truncate_display(text, max(0, w - x - 1))
    try:
        win.addstr(y, x, text, attr)
    except curses.error:
        pass


def compose_row(left: str, right: str, width: int) -> str:
    """Fit one provider row, keeping its short status aligned when possible."""
    if width <= 0:
        return ""
    if not right:
        return truncate_display(left, width)
    right = truncate_display(right, width)
    right_width = display_width(right)
    if right_width + 2 >= width:
        return truncate_display(left, width)
    left = truncate_display(left, width - right_width - 2)
    gap = max(2, width - display_width(left) - right_width)
    return truncate_display(left + (" " * gap) + right, width)


def pad_display(text: str, width: int) -> str:
    """Clip to ``width`` and pad with spaces so the row fills exactly ``width``."""
    clipped = truncate_display(text, width)
    return clipped + (" " * max(0, width - display_width(clipped)))


def truncate_display(text: str, max_width: int) -> str:
    """Clip text without placing half of a wide character outside the window."""
    if max_width <= 0:
        return ""
    used = 0
    result: list[str] = []
    for char in text:
        char_width = _char_width(char)
        if used + char_width > max_width:
            break
        result.append(char)
        used += char_width
    return "".join(result)


def display_width(text: str) -> int:
    """终端显示宽度：CJK 全角字符按 2 列计。"""
    return sum(_char_width(char) for char in text)


def _drop_display_prefix(text: str, width: int) -> str:
    """Drop the leading ``width`` display columns, used for negative x offsets."""
    if width <= 0:
        return text
    used = 0
    for index, char in enumerate(text):
        used += _char_width(char)
        if used >= width:
            return text[index + 1 :]
    return ""


def _char_width(char: str) -> int:
    if unicodedata.combining(char) or unicodedata.category(char) in {"Cf", "Cc"}:
        return 0
    return 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
