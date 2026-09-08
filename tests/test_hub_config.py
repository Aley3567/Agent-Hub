"""The config interpreter is pure: arguments in, normalized config or error out.

`claude-hub.py` covers what each field means. These tests cover only what became
true when interpretation moved into its own module: it loads without the server's
world, it reaches no reader, and its field order -- which decides *which* error a
half-broken config reports -- is a contract rather than an accident.
"""

import subprocess
import sys
import unittest
from pathlib import Path

from claude1_hub_config import ConfigError, validate_config

ROOT = Path(__file__).resolve().parents[1]


def _minimal_raw(**updates):
    raw = {
        "port": 18787,
        "default_channel": "fast",
        "channels": {"fast": {"provider": "Fixture", "models": ["fixture-model"]}},
    }
    raw.update(updates)
    return raw


class PureInterpretationTests(unittest.TestCase):
    def test_overrides_come_from_the_injected_environment_only(self):
        cfg = validate_config(
            _minimal_raw(local_token_env="FIXTURE_HUB_TOKEN"),
            env={"CLAUDE_HUB_PORT": "20001", "FIXTURE_HUB_TOKEN": "injected"},
        )

        self.assertEqual(cfg["port"], 20001)
        self.assertEqual(cfg["local_token"], "injected")

    def test_empty_port_override_falls_back_to_the_configured_value(self):
        cfg = validate_config(
            _minimal_raw(),
            env={"CLAUDE_HUB_PORT": "", "CLAUDE_HUB_LOCAL_TOKEN": "injected"},
        )

        self.assertEqual(cfg["port"], 18787)

    def test_result_is_detached_from_the_raw_document(self):
        raw = _minimal_raw()
        cfg = validate_config(raw, env={"CLAUDE_HUB_LOCAL_TOKEN": "injected"})

        cfg["channels"]["fast"]["models"].append("mutated")

        self.assertEqual(raw["channels"]["fast"]["models"], ["fixture-model"])

    def test_module_exposes_no_reader(self):
        """No name in scope can open the config file or the provider database."""
        import claude1_hub_config

        readers = (
            "get_config",
            "config_path",
            "get_providers",
            "_read_provider_rows",
            "os",
            "sqlite3",
            "Path",
        )
        for reader in readers:
            self.assertFalse(
                hasattr(claude1_hub_config, reader),
                f"the interpreter must not expose {reader}",
            )

    def test_imports_without_the_server_module(self):
        probe = (
            "import sys, claude1_hub_config as c;"
            "assert 'aiohttp' not in sys.modules;"
            "print(c.validate_config("
            "{'port': 1234, 'default_channel': 'a',"
            " 'channels': {'a': {'provider': 'p', 'models': ['m']}}},"
            " env={'CLAUDE_HUB_LOCAL_TOKEN': 'injected'})['port'])"
        )
        result = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "1234")


class FieldOrderTests(unittest.TestCase):
    """A config broken in several places reports the earliest field in the order."""

    def _first_error(self, raw):
        with self.assertRaises(ConfigError) as caught:
            validate_config(raw, env={"CLAUDE_HUB_LOCAL_TOKEN": "injected"})
        return str(caught.exception)

    def test_version_is_reported_before_channels(self):
        raw = _minimal_raw(version=3, channels={})
        self.assertIn("version", self._first_error(raw))

    def test_channels_are_reported_before_default_channel(self):
        raw = _minimal_raw(default_channel="missing", channels={"fast": "not-an-object"})
        self.assertIn("channels.fast", self._first_error(raw))

    def test_default_channel_is_reported_before_routes(self):
        raw = _minimal_raw(
            default_channel="missing",
            routes={"group": [{"channel": "unknown", "model": "fixture-model"}]},
        )
        self.assertIn("default_channel", self._first_error(raw))

    def test_local_token_is_reported_before_port(self):
        raw = _minimal_raw(port="not-a-port")
        with self.assertRaises(ConfigError) as caught:
            validate_config(raw, env={})
        self.assertIn("local_token", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
