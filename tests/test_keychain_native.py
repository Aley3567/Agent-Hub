"""Opt-in native probe; only synthetic items in an explicitly named temporary Keychain."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from claude_hub.credentials import MacOSKeychainStore


@unittest.skipUnless(sys.platform == "darwin" and os.environ.get("AGENT_HUB_TEST_KEYCHAIN") == "1",
                     "requires opt-in macOS temporary Keychain probe")
class NativeKeychainTests(unittest.TestCase):
    def test_synthetic_secret_create_read_update_delete_roundtrip(self):
        with tempfile.TemporaryDirectory(prefix="agent-hub-keychain-") as directory:
            path = Path(directory) / 'fixture "quoted" keychain.keychain-db'
            command = ["/usr/bin/security", "create-keychain", "-p", "synthetic-fixture", str(path)]
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=15)
            try:
                subprocess.run(["/usr/bin/security", "unlock-keychain", "-p", "synthetic-fixture", str(path)],
                               check=True, capture_output=True, text=True, timeout=15)
                store = MacOSKeychainStore(service_name='agent-hub-fixture "quotes" \\ service', keychain_path=path)
                reference = uuid4()
                self.assertIsNone(store.get_secret(reference))
                for value in ["fixture-ascii", "deadbeef01234567", 'fixture "quoted"',
                              "fixture \\ backslash", "fixture 中文", "fixture\ntrailing\n", "  fixture  "]:
                    with self.subTest(value=value):
                        store.set_secret(reference, value)
                        self.assertEqual(store.get_secret(reference), value)
                self.assertTrue(store.delete_secret(reference))
                self.assertIsNone(store.get_secret(reference))
                self.assertFalse(store.delete_secret(reference))
            finally:
                subprocess.run(["/usr/bin/security", "delete-keychain", str(path)],
                               check=True, capture_output=True, text=True, timeout=15)


if __name__ == "__main__":
    unittest.main()
