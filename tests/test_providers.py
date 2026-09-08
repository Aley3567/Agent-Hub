"""The snapshot cache owns when a refresh runs, not how it reads.

`test_claude_hub.py` covers the real database path -- WAL copies, permission
rechecks, replacement, single-flight under threads. These tests cover the cache
in isolation, with a fake refresh, so its own rules are visible without a
database: what counts as a hit, what a failure is allowed to do to the warm
entry, and that it works with no logger attached.
"""

import subprocess
import sys
import unittest
from pathlib import Path

from claude1_providers import ProviderDatabaseError, ProviderSnapshotCache

ROOT = Path(__file__).resolve().parents[1]


class SnapshotCacheTests(unittest.TestCase):
    def setUp(self):
        self.logged = []
        self.cache = ProviderSnapshotCache(log=self.logged.append)

    def _refresh(self, revision, providers, elapsed_ms=7):
        def refresh():
            return revision, providers, elapsed_ms

        return refresh

    def test_matching_revision_is_a_hit_that_never_refreshes(self):
        warm = {"provider": {}}
        self.cache.load(("rev", 1), self._refresh(("rev", 1), warm))

        def explode():
            raise AssertionError("a hit must not refresh")

        self.assertIs(self.cache.load(("rev", 1), explode), warm)
        metrics = self.cache.metrics()
        self.assertEqual((metrics["hits"], metrics["misses"]), (1, 1))
        self.assertEqual(metrics["refreshes"], 1)

    def test_cached_entry_is_keyed_by_the_verified_revision(self):
        """A refresh that verifies a different revision keys the entry by it."""
        warm = {"provider": {}}
        self.cache.load(("observed", 1), self._refresh(("verified", 2), warm))

        self.assertIs(self.cache.load(("verified", 2), None), warm)

    def test_failed_refresh_keeps_the_warm_entry_and_counts_the_failure(self):
        warm = {"provider": {}}
        self.cache.load(("rev", 1), self._refresh(("rev", 1), warm))

        def boom():
            raise ProviderDatabaseError("boom")

        with self.assertRaisesRegex(ProviderDatabaseError, "boom"):
            self.cache.load(("rev", 2), boom)

        self.assertEqual(self.cache.metrics()["refresh_failures"], 1)
        self.assertEqual(self.cache.metrics()["refreshes"], 1)
        self.assertIs(self.cache.load(("rev", 1), None), warm)

    def test_operating_system_errors_are_reported_as_database_errors(self):
        def boom():
            raise PermissionError(13, "Permission denied")

        with self.assertRaisesRegex(
            ProviderDatabaseError, "provider database could not be read"
        ):
            self.cache.load(("rev", 1), boom)

    def test_refresh_and_failure_are_both_logged_once(self):
        self.cache.load(("rev", 1), self._refresh(("rev", 1), {}, elapsed_ms=42))

        def boom():
            raise ProviderDatabaseError("boom")

        with self.assertRaises(ProviderDatabaseError):
            self.cache.load(("rev", 2), boom)

        self.assertEqual(len(self.logged), 2)
        self.assertIn("refresh_ms=42", self.logged[0])
        self.assertIn("refresh_failed failures=1", self.logged[1])
        self.assertIn("error=ProviderDatabaseError", self.logged[1])

    def test_reset_clears_the_entry_and_every_counter(self):
        self.cache.load(("rev", 1), self._refresh(("rev", 1), {"a": {}}))
        self.cache.load(("rev", 1), None)

        self.cache.reset()

        self.assertIsNone(self.cache._entry)
        self.assertEqual(
            self.cache.metrics(),
            {
                "hits": 0,
                "misses": 0,
                "refreshes": 0,
                "refresh_failures": 0,
                "samples": 0,
                "p50_ms": 0,
                "p95_ms": 0,
            },
        )

    def test_a_cache_without_a_logger_stays_silent(self):
        cache = ProviderSnapshotCache()
        providers = {"provider": {}}

        self.assertIs(
            cache.load(("rev", 1), self._refresh(("rev", 1), providers)), providers
        )

        def boom():
            raise ProviderDatabaseError("boom")

        with self.assertRaises(ProviderDatabaseError):
            cache.load(("rev", 2), boom)
        self.assertEqual(cache.metrics()["refresh_failures"], 1)


class ModuleBoundaryTests(unittest.TestCase):
    def test_imports_without_the_server_module(self):
        probe = (
            "import sys, claude1_providers as p;"
            "assert 'aiohttp' not in sys.modules;"
            "c = p.ProviderSnapshotCache();"
            "print(c.load(('rev', 1), lambda: (('rev', 1), {'ok': 1}, 0))['ok'])"
        )
        result = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "1")


if __name__ == "__main__":
    unittest.main()
