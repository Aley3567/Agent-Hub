"""Claude model adapter and model projection tests."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.claude_models import (
    ClaudeModelAdapter,
    ClaudeModelDocumentError,
)
from claude_hub.domain import ModelMapping


class ClaudeModelsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = ClaudeModelAdapter()

    def test_project_standard_claude_env(self) -> None:
        doc = {
            "env": {
                "ANTHROPIC_MODEL": "claude-3-5-sonnet-20241022",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-3-5-haiku-20241022",
                "ANTHROPIC_REASONING_MODEL": "claude-3-7-sonnet-thinking",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-3-5-sonnet-v2",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-3-opus",
                "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-3-fable",
            }
        }
        models = self.adapter.project(doc)
        self.assertEqual(models.default, "claude-3-5-sonnet-20241022")
        self.assertEqual(models.fast, "claude-3-5-haiku-20241022")
        self.assertEqual(models.reasoning, "claude-3-7-sonnet-thinking")
        self.assertEqual(models.coding, "claude-3-5-sonnet-v2")
        self.assertEqual(models.long_context, "claude-3-opus")
        self.assertEqual(models.fallback, "claude-3-fable")

    def test_project_fast_alias_env(self) -> None:
        doc = {
            "env": {
                "ANTHROPIC_MODEL": "claude-sonnet",
                "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-alias",
            }
        }
        models = self.adapter.project(doc)
        self.assertEqual(models.fast, "claude-haiku-alias")

    def test_project_empty_env(self) -> None:
        doc = {"env": {}}
        models = self.adapter.project(doc)
        self.assertEqual(models.configured_slots, ())

    def test_project_invalid_document_raises(self) -> None:
        with self.assertRaises(ClaudeModelDocumentError):
            self.adapter.project("not-a-dict")  # type: ignore
        with self.assertRaises(ClaudeModelDocumentError):
            self.adapter.project({"env": "not-a-dict"})

    def test_unknown_fields_summary(self) -> None:
        doc = {
            "env": {
                "ANTHROPIC_MODEL": "claude-sonnet",
                "CUSTOM_ENDPOINT": "https://custom.api",
                "EXTRA_TIMEOUT": "30",
            }
        }
        summary = self.adapter.unknown_fields(doc)
        self.assertEqual(summary.count, 2)
        self.assertEqual(len(summary.fingerprint), 64)

    def test_fingerprint_is_deterministic(self) -> None:
        doc1 = {"env": {"A": "1", "B": "2"}}
        doc2 = {"env": {"B": "2", "A": "1"}}
        self.assertEqual(self.adapter.fingerprint(doc1), self.adapter.fingerprint(doc2))

    def test_patch_preserves_unrelated_fields_on_deepcopy(self) -> None:
        orig = {
            "name": "Custom",
            "env": {
                "ANTHROPIC_MODEL": "old-model",
                "CUSTOM_TOKEN": "preserve-me",
            },
        }
        new_models = ModelMapping(default="new-sonnet", fast="new-haiku")
        patched = self.adapter.patch(orig, new_models)
        self.assertNotEqual(id(orig), id(patched))
        self.assertEqual(orig["env"]["ANTHROPIC_MODEL"], "old-model")
        self.assertEqual(patched["env"]["ANTHROPIC_MODEL"], "new-sonnet")
        self.assertEqual(patched["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "new-haiku")
        self.assertEqual(patched["env"]["CUSTOM_TOKEN"], "preserve-me")


if __name__ == "__main__":
    unittest.main()
