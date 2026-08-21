"""Guard the CLAUDE.md docs index against drift, and force docs to declare death.

Two failure modes cost real time on this repo, and both are mechanical enough to
test:

* A stale index quietly costs an agent the very evidence CLAUDE.md told it to read
  (``cache-diagnosis-2026-08-19.md`` sat unindexed while ``work-queue.md``
  depended on it).
* A doc with no stated expiry condition is immortal, because proving it dead means
  reading it in full and chasing every reference -- more expensive than keeping it.
  That is the whole reason docs/ only ever grows.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLAUDE_MD = ROOT / "CLAUDE.md"
DOCS = ROOT / "docs"

INDEX_HEADING = "## docs/ 索引"

# Per-directory README files explain their own folder; they are not index rows.
SELF_DESCRIBING = "README.md"

# Groups whose members go stale, so each must state when it may be retired.
# "永不归档" is a valid answer -- exclusion records earn permanent residency.
EXPIRY_MARKER = "失效条件"
GROUPS_NEEDING_EXPIRY = ("参考矩阵", "证据层")

# First-screen budget: enough for a title plus the banner block above the body.
FIRST_SCREEN_CHARS = 2000

ROW_PATTERN = re.compile(r"-\s+`([^`]+\.md)`")


def _index_section() -> str:
    text = CLAUDE_MD.read_text(encoding="utf-8")
    _, sep, tail = text.partition(INDEX_HEADING)
    assert sep, f"CLAUDE.md lost its {INDEX_HEADING!r} section"
    return tail


def _indexed_paths() -> set[str]:
    """Every ``- `name.md`` bullet in the index, as a docs-relative path."""
    rows = ROW_PATTERN.findall(_index_section())
    return {row.lstrip("/") for row in rows}


def _grouped_paths(label: str) -> set[str]:
    """Index rows under one bold group heading such as ``**证据层**``."""
    rows: set[str] = set()
    capturing = False
    for line in _index_section().splitlines():
        if line.startswith("**"):
            capturing = line.startswith(f"**{label}**")
            continue
        if capturing:
            match = ROW_PATTERN.match(line)
            if match:
                rows.add(match.group(1))
    return rows


def _tracked_paths() -> set[str]:
    return {
        str(path.relative_to(DOCS))
        for path in DOCS.rglob("*.md")
        if path.name != SELF_DESCRIBING
    }


class DocsIndexTest(unittest.TestCase):
    def test_every_doc_is_indexed(self) -> None:
        missing = sorted(_tracked_paths() - _indexed_paths())
        self.assertEqual(
            missing,
            [],
            "docs/ files absent from the CLAUDE.md index: " + ", ".join(missing),
        )

    def test_index_points_at_existing_files(self) -> None:
        dangling = sorted(
            name for name in _indexed_paths() if not (DOCS / name).is_file()
        )
        self.assertEqual(
            dangling,
            [],
            "CLAUDE.md index names files that do not exist: " + ", ".join(dangling),
        )

    def test_archived_docs_are_indexed_under_archive(self) -> None:
        archive = DOCS / "archive"
        if not archive.is_dir():
            self.skipTest("no archive directory yet")
        indexed = _indexed_paths()
        for path in archive.glob("*.md"):
            if path.name == SELF_DESCRIBING:
                continue
            rel = str(path.relative_to(DOCS))
            self.assertIn(
                rel,
                indexed,
                f"archived doc {rel} must stay listed so readers learn it is retired",
            )

    def test_archive_documents_its_own_criteria(self) -> None:
        readme = DOCS / "archive" / SELF_DESCRIBING
        if not readme.parent.is_dir():
            self.skipTest("no archive directory yet")
        self.assertTrue(
            readme.is_file(),
            "docs/archive/ needs a README stating the archive criteria",
        )

    def test_expiry_groups_are_still_parseable(self) -> None:
        """A renamed group would silently empty the expiry check below."""
        section = _index_section()
        for label in GROUPS_NEEDING_EXPIRY:
            self.assertIn(
                f"**{label}**",
                section,
                f"index group {label} is gone; the expiry guard would pass vacuously",
            )
            self.assertTrue(
                _grouped_paths(label),
                f"index group {label} lists no docs; check the bullet format",
            )

    def test_perishable_docs_declare_an_expiry_condition(self) -> None:
        missing = []
        for label in GROUPS_NEEDING_EXPIRY:
            for name in sorted(_grouped_paths(label)):
                head = (DOCS / name).read_text(encoding="utf-8")[:FIRST_SCREEN_CHARS]
                if EXPIRY_MARKER not in head:
                    missing.append(f"{label} · {name}")
        self.assertEqual(
            missing,
            [],
            f"docs missing a first-screen 「{EXPIRY_MARKER}」 line: " + ", ".join(missing),
        )


if __name__ == "__main__":
    unittest.main()
