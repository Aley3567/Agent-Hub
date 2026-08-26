from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import claude1_context_window as ctx

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "claude-provider-once.py"


@contextmanager
def loaded_launcher(env: dict[str, str]):
    """Load a fresh launcher module under an isolated runtime env."""
    with mock.patch.dict(os.environ, env, clear=False):
        name = f"claude1_launcher_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(name, LAUNCHER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        # Register before exec so dataclasses can resolve string annotations.
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
            yield module
        finally:
            sys.modules.pop(name, None)


class SuffixHelpersTest(unittest.TestCase):
    def test_strip_removes_repeated_and_mixed_case_markers(self):
        self.assertEqual(ctx.strip_suffix("claude-opus-5[1m]"), "claude-opus-5")
        self.assertEqual(ctx.strip_suffix("claude-opus-5[1M]"), "claude-opus-5")
        self.assertEqual(ctx.strip_suffix("glm-5.3[1m][1M]"), "glm-5.3")
        self.assertEqual(ctx.strip_suffix("  k3-256k[1M]  "), "k3-256k")

    def test_strip_keeps_inner_marker_only_when_not_trailing(self):
        # ``Ov`` matches anywhere, so a non-trailing marker still means 1M to the
        # client even though it is not a suffix.
        self.assertTrue(ctx.has_suffix("weird[1m]-model"))
        self.assertEqual(ctx.strip_suffix("weird[1m]-model"), "weird[1m]-model")

    def test_with_suffix_is_idempotent(self):
        self.assertEqual(ctx.with_suffix("glm-5.3"), "glm-5.3[1m]")
        self.assertEqual(ctx.with_suffix("glm-5.3[1M]"), "glm-5.3[1m]")
        self.assertEqual(ctx.with_suffix(ctx.with_suffix("glm-5.3")), "glm-5.3[1m]")

    def test_is_official_id_ignores_the_marker_and_case(self):
        self.assertTrue(ctx.is_official_id("Claude-Opus-5[1M]"))
        self.assertFalse(ctx.is_official_id("moonshotai/Kimi-K3[1M]"))

    def test_format_window(self):
        self.assertEqual(ctx.format_window(1_000_000), "1M")
        self.assertEqual(ctx.format_window(200_000), "200k")
        self.assertEqual(ctx.format_window(262_144), "262144")


class MatrixIntegrityTest(unittest.TestCase):
    def test_native_1m_models_carry_a_1m_window(self):
        for model, entry in ctx.CONTEXT_MATRIX.items():
            if entry.native_1m:
                self.assertEqual(entry.window, ctx.ONE_M, model)

    def test_non_native_models_are_below_1m(self):
        for model, entry in ctx.CONTEXT_MATRIX.items():
            if not entry.native_1m:
                self.assertLess(entry.window, ctx.ONE_M, model)

    def test_registry_lookup_normalises_case_and_marker(self):
        self.assertIsNotNone(ctx.registry_entry("CLAUDE-OPUS-5[1M]"))
        self.assertIsNone(ctx.registry_entry("claude-opus-9"))


class RegistryModelPlanTest(unittest.TestCase):
    def test_native_1m_model_drops_a_redundant_suffix(self):
        plan = ctx.resolve_context_window("claude-opus-5[1m]")
        self.assertEqual(plan.model_out, "claude-opus-5")
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertEqual(plan.source, ctx.SOURCE_REGISTRY)
        self.assertEqual(plan.env, {})
        self.assertIn(ctx.WARN_REDUNDANT_SUFFIX, plan.warnings)

    def test_native_1m_model_without_suffix_is_silent(self):
        plan = ctx.resolve_context_window("claude-fable-5")
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertEqual(plan.warnings, ())

    def test_beta_model_reaches_1m_only_through_a_capable_provider(self):
        plan = ctx.resolve_context_window(
            "claude-sonnet-4-6", want_1m=True, provider_kind="firstParty"
        )
        self.assertEqual(plan.model_out, "claude-sonnet-4-6[1m]")
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertTrue(plan.beta_reaches_upstream)
        self.assertEqual(plan.warnings, ())

    def test_beta_model_behind_a_gateway_keeps_the_registry_window(self):
        plan = ctx.resolve_context_window(
            "claude-sonnet-4-6[1m]", provider_kind="custom"
        )
        self.assertEqual(plan.model_out, "claude-sonnet-4-6")
        self.assertEqual(plan.window, 200_000)
        self.assertFalse(plan.beta_reaches_upstream)
        self.assertIn(ctx.WARN_SUFFIX_WITHOUT_BETA, plan.warnings)

    def test_model_without_beta_support_never_reports_1m(self):
        plan = ctx.resolve_context_window(
            "claude-haiku-4-5[1m]", provider_kind="firstParty"
        )
        self.assertEqual(plan.window, 200_000)
        self.assertIn(ctx.WARN_SUFFIX_WITHOUT_BETA, plan.warnings)

    def test_declared_window_is_reported_as_ignored_for_registry_models(self):
        plan = ctx.resolve_context_window("claude-opus-5", declared_window=500_000)
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertEqual(plan.env, {})
        self.assertIn(ctx.WARN_DECLARED_IGNORED, plan.warnings)

    def test_disable_1m_neutralises_the_suffix(self):
        plan = ctx.resolve_context_window(
            "claude-sonnet-4-6[1m]", provider_kind="firstParty", disable_1m=True
        )
        self.assertEqual(plan.model_out, "claude-sonnet-4-6")
        self.assertEqual(plan.window, 200_000)


class UnknownOfficialModelPlanTest(unittest.TestCase):
    def test_unknown_claude_model_cannot_use_the_env_var(self):
        plan = ctx.resolve_context_window(
            "claude-opus-9", declared_window=400_000
        )
        self.assertEqual(plan.env, {})
        self.assertEqual(plan.window, ctx.DEFAULT_UNKNOWN_WINDOW)
        self.assertEqual(plan.source, ctx.SOURCE_ASSUMED)
        self.assertIn(ctx.WARN_DECLARED_IGNORED, plan.warnings)
        self.assertIn(ctx.WARN_UNKNOWN_OFFICIAL, plan.warnings)

    def test_unknown_claude_model_with_suffix_is_1m_client_side(self):
        plan = ctx.resolve_context_window("claude-opus-9[1m]")
        self.assertEqual(plan.model_out, "claude-opus-9[1m]")
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertEqual(plan.source, ctx.SOURCE_SUFFIX)


class ThirdPartyModelPlanTest(unittest.TestCase):
    def test_declared_window_replaces_a_fake_1m_suffix(self):
        plan = ctx.resolve_context_window(
            "moonshotai/Kimi-K3[1M]", declared_window=262_144
        )
        self.assertEqual(plan.model_out, "moonshotai/Kimi-K3")
        self.assertEqual(plan.window, 262_144)
        self.assertEqual(plan.source, ctx.SOURCE_DECLARED)
        self.assertEqual(plan.env, {ctx.MAX_CONTEXT_TOKENS_ENV: "262144"})
        self.assertIn(ctx.WARN_FAKE_1M, plan.warnings)

    def test_declared_window_without_suffix_is_silent(self):
        plan = ctx.resolve_context_window("glm-5.3", declared_window=200_000)
        self.assertEqual(plan.env, {ctx.MAX_CONTEXT_TOKENS_ENV: "200000"})
        self.assertEqual(plan.warnings, ())

    def test_declared_beats_probed(self):
        plan = ctx.resolve_context_window(
            "glm-5.3", declared_window=131_072, probed_window=262_144
        )
        self.assertEqual(plan.window, 131_072)
        self.assertEqual(plan.source, ctx.SOURCE_DECLARED)

    def test_probed_window_is_used_when_nothing_is_declared(self):
        plan = ctx.resolve_context_window("glm-5.3", probed_window=262_144)
        self.assertEqual(plan.window, 262_144)
        self.assertEqual(plan.source, ctx.SOURCE_PROBED)

    def test_suffix_at_exactly_1m_is_only_redundant(self):
        plan = ctx.resolve_context_window(
            "glm-5.3[1m]", declared_window=ctx.ONE_M
        )
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertIn(ctx.WARN_REDUNDANT_SUFFIX, plan.warnings)
        self.assertNotIn(ctx.WARN_FAKE_1M, plan.warnings)

    def test_unknown_window_with_suffix_is_flagged_as_fake_1m(self):
        plan = ctx.resolve_context_window("k3[1M]")
        self.assertEqual(plan.window, ctx.ONE_M)
        self.assertEqual(plan.source, ctx.SOURCE_SUFFIX)
        self.assertIn(ctx.WARN_FAKE_1M, plan.warnings)
        self.assertEqual(plan.env, {})

    def test_unknown_window_without_suffix_keeps_the_cli_assumption(self):
        plan = ctx.resolve_context_window("k3-256k")
        self.assertEqual(plan.window, ctx.DEFAULT_UNKNOWN_WINDOW)
        self.assertEqual(plan.source, ctx.SOURCE_ASSUMED)
        self.assertIn(ctx.WARN_WINDOW_UNDECLARED, plan.warnings)


class DeclaredWindowParsingTest(unittest.TestCase):
    def test_reads_nested_capability(self):
        settings = {"claude1_capabilities": {"context_window": 262_144}}
        self.assertEqual(ctx.declared_window_from_settings(settings), 262_144)

    def test_accepts_a_numeric_string(self):
        settings = {"claude1_capabilities": {"context_window": " 262144 "}}
        self.assertEqual(ctx.declared_window_from_settings(settings), 262_144)

    def test_rejects_unusable_shapes_without_raising(self):
        for value in (None, 0, -1, True, "abc", "", [262_144], {"n": 1}):
            settings = {"claude1_capabilities": {"context_window": value}}
            self.assertIsNone(
                ctx.declared_window_from_settings(settings), repr(value)
            )

    def test_tolerates_missing_or_wrong_container(self):
        self.assertIsNone(ctx.declared_window_from_settings(None))
        self.assertIsNone(ctx.declared_window_from_settings({}))
        self.assertIsNone(
            ctx.declared_window_from_settings({"claude1_capabilities": []})
        )


class LauncherContextIntegrationTest(unittest.TestCase):
    def _env(self, home: Path) -> dict[str, str]:
        return {
            "HOME": str(home),
            "CLAUDE1_HOME": str(home),
            "CLAUDE1_CONTEXT_CACHE": str(home / "context-cache.json"),
        }

    def test_provider_kind_classification(self):
        with loaded_launcher(self._env(Path(self.home))) as module:
            self.assertEqual(module.provider_context_kind(None), "firstParty")
            self.assertEqual(module.provider_context_kind(""), "firstParty")
            self.assertEqual(
                module.provider_context_kind("https://api.anthropic.com"),
                "firstParty",
            )
            self.assertEqual(
                module.provider_context_kind("https://ps.example.com"), "custom"
            )
            self.assertEqual(
                module.provider_context_kind("http://127.0.0.1:15721"), "custom"
            )

    def test_cache_round_trip_is_keyed_by_base_url_and_bare_model(self):
        with loaded_launcher(self._env(Path(self.home))) as module:
            module.store_context_window("https://a.example.com/", "k3[1M]", 262_144)
            self.assertEqual(
                module.cached_context_window("https://a.example.com", "k3"), 262_144
            )
            # A different upstream must not inherit the window.
            self.assertIsNone(
                module.cached_context_window("https://b.example.com", "k3")
            )
            self.assertEqual(
                (module.CONTEXT_CACHE_PATH.stat().st_mode & 0o777), 0o600
            )

    def test_damaged_cache_is_ignored(self):
        home = Path(self.home)
        with loaded_launcher(self._env(home)) as module:
            module.CONTEXT_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            module.CONTEXT_CACHE_PATH.write_text("{not json", encoding="utf-8")
            self.assertEqual(module.load_context_cache(), {})
            module.CONTEXT_CACHE_PATH.write_text(
                json.dumps({"version": 999, "entries": {"x": {"window": 1}}}),
                encoding="utf-8",
            )
            self.assertEqual(module.load_context_cache(), {})

    def test_slot_plan_prefers_declaration_over_cache(self):
        with loaded_launcher(self._env(Path(self.home))) as module:
            module.store_context_window("https://a.example.com", "glm-5.3", 262_144)
            settings = {
                "env": {"ANTHROPIC_BASE_URL": "https://a.example.com"},
                "claude1_capabilities": {"context_window": 131_072},
            }
            plan = module.slot_context_plan(
                "glm-5.3", settings, base_url="https://a.example.com"
            )
            self.assertEqual(plan.window, 131_072)
            self.assertEqual(plan.source, ctx.SOURCE_DECLARED)

    def test_findings_group_and_classify_real_providers(self):
        rows = [
            {
                "name": "provider-fake-window",
                "settings_config": json.dumps(
                    {
                        "env": {
                            "ANTHROPIC_BASE_URL": "https://gw.example.com",
                            "ANTHROPIC_MODEL": "glm-5.3[1m]",
                            "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3[1m]",
                        }
                    }
                ),
            },
            {
                "name": "declared-ok",
                "settings_config": json.dumps(
                    {
                        "env": {
                            "ANTHROPIC_BASE_URL": "https://gw.example.com",
                            "ANTHROPIC_MODEL": "k3-256k",
                        },
                        "claude1_capabilities": {"context_window": 262_144},
                    }
                ),
            },
            {
                "name": "official-native",
                "settings_config": json.dumps(
                    {"env": {"ANTHROPIC_MODEL": "claude-opus-5"}}
                ),
            },
            {"name": "broken", "settings_config": "{not json"},
        ]
        with loaded_launcher(self._env(Path(self.home))) as module:
            findings, probed = module.context_window_findings(rows, probe=False)
        self.assertEqual(probed, 0)
        codes = {(item.provider, item.code) for item in findings}
        self.assertIn(("provider-fake-window", ctx.WARN_FAKE_1M), codes)
        # Two slots on one provider produce two findings that the doctor groups.
        self.assertEqual(
            sum(1 for item in findings if item.provider == "provider-fake-window"), 2
        )
        self.assertNotIn("declared-ok", {item.provider for item in findings})
        self.assertNotIn("official-native", {item.provider for item in findings})
        self.assertNotIn("broken", {item.provider for item in findings})

    def test_probe_parses_a_model_listing_and_caches_it(self):
        payload = json.dumps(
            {
                "data": [
                    {"id": "other-model", "context_length": 8_000},
                    {"id": "k3-256k", "context_length": 262_144},
                ]
            }
        ).encode("utf-8")

        class FakeResponse:
            status = 200

            def getcode(self):
                return self.status

            def read(self, _size=None):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        with loaded_launcher(self._env(Path(self.home))) as module:
            with mock.patch.object(
                module.urllib.request, "urlopen", return_value=FakeResponse()
            ):
                window = module.probe_upstream_context_window(
                    "https://gw.example.com", "a-token-long-enough", "k3-256k[1M]"
                )
            self.assertEqual(window, 262_144)

    def test_probe_returns_none_when_the_model_is_absent(self):
        payload = json.dumps({"data": [{"id": "other", "context_length": 8}]}).encode()

        class FakeResponse:
            status = 200

            def getcode(self):
                return self.status

            def read(self, _size=None):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        with loaded_launcher(self._env(Path(self.home))) as module:
            with mock.patch.object(
                module.urllib.request, "urlopen", return_value=FakeResponse()
            ):
                self.assertIsNone(
                    module.probe_upstream_context_window(
                        "https://gw.example.com", None, "k3-256k"
                    )
                )

    def test_probe_survives_a_transport_failure(self):
        with loaded_launcher(self._env(Path(self.home))) as module:
            with mock.patch.object(
                module.urllib.request,
                "urlopen",
                side_effect=module.urllib.error.URLError("down"),
            ):
                self.assertIsNone(
                    module.probe_upstream_context_window(
                        "https://gw.example.com", "a-token-long-enough", "k3"
                    )
                )

    def test_models_endpoint_does_not_double_the_version_segment(self):
        with loaded_launcher(self._env(Path(self.home))) as module:
            self.assertEqual(
                module._models_endpoint("https://a.example.com"),
                "https://a.example.com/v1/models",
            )
            self.assertEqual(
                module._models_endpoint("https://a.example.com/v1/"),
                "https://a.example.com/v1/models",
            )

    def test_probe_credential_rejects_placeholders(self):
        with loaded_launcher(self._env(Path(self.home))) as module:
            self.assertIsNone(module._probe_credential({}))
            self.assertIsNone(
                module._probe_credential({"ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED"})
            )
            self.assertIsNone(
                module._probe_credential({"ANTHROPIC_AUTH_TOKEN": "short"})
            )
            self.assertEqual(
                module._probe_credential(
                    {"ANTHROPIC_API_KEY": "fixture-credential-value-12345"}
                ),
                "fixture-credential-value-12345",
            )

    def setUp(self):
        self._tmp = __import__("tempfile").TemporaryDirectory()
        self.home = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
