"""Ratchet the count of over-long functions downward, never up.

Long functions are the reason every doc in this repo has to say "line numbers
drift, locate by symbol name": inside a 549-line function the symbol name does
not locate anything, so prose falls back to line numbers, which then rot.  Split
the function and the line-number problem disappears on its own.

AI-assisted edits regress toward longer functions -- appending a branch to an
existing 400-line function is easier than finding the seam.  This test pins the
current per-file count so refactors can only improve it.

When a count drops, tighten BASELINE to the new number in the same commit.  That
is the ratchet: an improvement that is not recorded gets silently given back.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MAX_LINES = 120

# Measured 2026-08-21.  Only ever edit these downward.
BASELINE = {
    "claude1_protocol.py": 10,
    "claude-hub.py": 7,
    "claude-provider-once.py": 7,
    "claude1_account_pool.py": 1,
}

# Longest single function per file.  Splitting a 549-line function into 300 + two
# helpers leaves BASELINE unchanged, so without this second dimension the win
# would be invisible and could silently be given back.
#
# claude-hub.py's number no longer belongs to _forward_to_channel: two cuts took
# it 549 -> 437 and _handle_transformed_messages now holds the ceiling.  Binding
# that path's turn identity through _TurnJournal (the same abstraction the native
# path already used) took it 467 -> 465; shared upstream-error preparation took
# the transformed path to 464.
WORST = {
    "claude1_protocol.py": 426,
    "claude-hub.py": 464,
    "claude-provider-once.py": 313,
    "claude1_account_pool.py": 124,
}


def _over_long(path: Path) -> list[tuple[int, str, int]]:
    """(length, name, lineno) for every function longer than MAX_LINES."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            length = node.end_lineno - node.lineno + 1
            if length > MAX_LINES:
                found.append((length, node.name, node.lineno))
    return sorted(found, reverse=True)


class FunctionLengthRatchetTest(unittest.TestCase):
    def test_counts_do_not_regress(self) -> None:
        for name, allowed in sorted(BASELINE.items()):
            path = ROOT / name
            if not path.is_file():
                continue
            found = _over_long(path)
            worst = ", ".join(f"{n}({ln} 行)" for ln, n, _ in found[:3])
            self.assertLessEqual(
                len(found),
                allowed,
                f"{name}: over-long functions {len(found)} > baseline {allowed}. "
                f"Longest: {worst}",
            )
            self.assertEqual(
                len(found),
                allowed,
                f"{name}: down to {len(found)} from baseline {allowed} -- "
                f"tighten BASELINE in this file to lock the win.",
            )

    def test_longest_function_does_not_regress(self) -> None:
        for name, allowed in sorted(WORST.items()):
            path = ROOT / name
            if not path.is_file():
                continue
            found = _over_long(path)
            worst = found[0][0] if found else 0
            self.assertLessEqual(
                worst,
                allowed,
                f"{name}: longest function {worst} > baseline {allowed} "
                f"({found[0][1]!r})" if found else "",
            )
            self.assertEqual(
                worst,
                allowed,
                f"{name}: longest is now {worst}, baseline says {allowed} -- "
                f"tighten WORST in this file to lock the win.",
            )

    def test_no_unlisted_file_grows_long_functions(self) -> None:
        """A new module must not quietly start out with over-long functions."""
        offenders = {}
        for path in sorted(ROOT.glob("*.py")):
            if path.name in BASELINE:
                continue
            try:
                found = _over_long(path)
            except SyntaxError:
                continue
            if found:
                offenders[path.name] = [(n, ln) for ln, n, _ in found]
        self.assertEqual(
            offenders,
            {},
            f"new over-long functions outside BASELINE: {offenders}. "
            "Split them, or add the file to BASELINE with a reason.",
        )


if __name__ == "__main__":
    unittest.main()
