from __future__ import annotations

import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "statusline-model.py"
SPEC = importlib.util.spec_from_file_location("statusline_model", MODULE_PATH)
statusline = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(statusline)


def iso(stamp: float) -> str:
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z")


class StatuslineModelTests(unittest.TestCase):
    def test_tail_lines_reads_only_the_bounded_utf8_suffix(self) -> None:
        last_line = json.dumps(
            {"type": "assistant", "message": {"model": "last-model"}},
            ensure_ascii=False,
        ).encode("utf-8") + b"\n"
        content = ("前" * 100).encode("utf-8") + b"\n" + last_line
        max_bytes = len(last_line) + 5

        class TrackingReader(io.BytesIO):
            read_start: int | None = None
            read_size: int | None = None

            def read(self, size: int = -1) -> bytes:
                self.read_start = self.tell()
                self.read_size = size
                return super().read(size)

        reader = TrackingReader(content)
        with mock.patch.object(Path, "open", return_value=reader) as open_file:
            lines = statusline._tail_lines(
                Path("unused"),
                max_bytes=max_bytes,
                max_lines=400,
            )

        open_file.assert_called_once_with("rb")
        self.assertEqual(reader.read_start, len(content) - max_bytes - 1)
        self.assertEqual(reader.read_size, max_bytes + 1)
        self.assertEqual(lines, [last_line.decode("utf-8").strip()])

    def test_latest_model_comes_from_the_bounded_transcript_tail(self) -> None:
        now = 2_000_000_000.0
        with tempfile.TemporaryDirectory() as raw:
            transcript = Path(raw) / "long-session.jsonl"
            prefix = ("旧" * statusline.TRANSCRIPT_TAIL_BYTES).encode("utf-8")
            last_row = {
                "type": "assistant",
                "timestamp": iso(now - 1),
                "message": {"model": "tail-model"},
            }
            transcript.write_bytes(
                prefix + b"\n" + json.dumps(last_row).encode("utf-8") + b"\n"
            )

            with mock.patch.object(
                Path,
                "read_text",
                side_effect=AssertionError("transcript must not be read in full"),
            ):
                model = statusline.latest_response_model(
                    str(transcript),
                    now=now,
                )

        self.assertEqual(model, "tail-model")

    def test_turn_metadata_does_not_invalidate_latest_assistant_model(self) -> None:
        now = 2_000_000_000.0
        with tempfile.TemporaryDirectory() as raw:
            transcript = Path(raw) / "session.jsonl"
            rows = [
                {
                    "type": "assistant",
                    "timestamp": iso(now - 2),
                    "message": {"model": "upstream-flash"},
                },
                {
                    "type": "user",
                    "sourceToolAssistantUUID": "assistant-tool-call",
                    "toolUseResult": {"ok": True},
                    "timestamp": iso(now - 1),
                    "message": {"content": [{"type": "tool_result"}]},
                },
                {
                    "type": "attachment",
                    "timestamp": iso(now - 0.5),
                },
                {
                    "type": "system",
                    "subtype": "turn_duration",
                    "timestamp": iso(now - 0.25),
                },
            ]
            transcript.write_text(
                "\n".join(json.dumps(row) for row in rows),
                encoding="utf-8",
            )
            payload = {
                "model": {"id": "startup-pro", "display_name": "Pro"},
                "transcript_path": str(transcript),
            }

            self.assertEqual(
                statusline.resolve_model(payload, {}, now=now),
                "upstream-flash",
            )

    def test_real_unanswered_user_turn_invalidates_old_assistant(self) -> None:
        now = 2_000_000_000.0
        with tempfile.TemporaryDirectory() as raw:
            transcript = Path(raw) / "session.jsonl"
            rows = [
                {
                    "type": "assistant",
                    "timestamp": iso(now - 2),
                    "message": {"model": "old-model"},
                },
                {
                    "type": "user",
                    "timestamp": iso(now - 1),
                    "message": {"content": "new real prompt"},
                },
            ]
            transcript.write_text(
                "\n".join(json.dumps(row) for row in rows),
                encoding="utf-8",
            )
            payload = {
                "model": {"id": "selected-model", "display_name": "Selected"},
                "transcript_path": str(transcript),
            }

            self.assertEqual(
                statusline.resolve_model(payload, {}, now=now),
                "selected-model",
            )

    def test_third_party_id_maps_by_exact_slot_value_not_tier_keyword(self) -> None:
        payload = {
            "model": {
                "id": "third-party-flash",
                "display_name": "Logical Opus",
            }
        }
        env = {
            "ANTHROPIC_MODEL": "startup-pro",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "third-party-flash",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Flash Friendly Name",
        }

        self.assertEqual(
            statusline.resolve_model(payload, env),
            "Flash Friendly Name",
        )

    def test_claude1_live_provider_route_wins_over_old_transcript_model(self) -> None:
        now = 2_000_000_000.0
        with tempfile.TemporaryDirectory() as raw:
            transcript = Path(raw) / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "timestamp": iso(now - 1),
                        "message": {"model": "claude-opus-5"},
                    }
                ),
                encoding="utf-8",
            )
            payload = {
                "model": {"id": "claude-opus-5", "display_name": "Opus"},
                "transcript_path": str(transcript),
            }
            env = {
                "CLAUDE1_SESSION_SOURCE": "provider",
                "ANTHROPIC_MODEL": "deepseek-v4-flash",
            }
            self.assertEqual(
                statusline.resolve_model(payload, env, now=now),
                "deepseek-v4-flash",
            )

    def test_concrete_in_session_model_wins_over_claude1_startup_route(self) -> None:
        """A /model switch must not be overwritten by the launch env."""
        payload = {
            "model": {
                "id": "DeepSeek-V4-Flash-0731",
                "display_name": "DeepSeek-V4-Flash-0731",
            }
        }
        env = {
            "CLAUDE1_SESSION_SOURCE": "provider",
            "ANTHROPIC_MODEL": "Qwen/Qwen3.5-9B",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "DeepSeek-V4-Flash-0731",
        }
        self.assertEqual(
            statusline.resolve_model(payload, env),
            "DeepSeek-V4-Flash-0731",
        )

    def test_claude1_live_hub_route_strips_channel_alias_for_display(self) -> None:
        payload = {"model": {"id": "claude-opus-5", "display_name": "Opus"}}
        env = {
            "CLAUDE1_SESSION_SOURCE": "hub",
            "CLAUDE1_CHANNEL_SELECTOR": "fixture-deep,deepseek-v4-flash",
        }
        self.assertEqual(
            statusline.resolve_model(payload, env),
            "deepseek-v4-flash",
        )

    def test_gateway_selector_id_outranks_frozen_startup_channel(self) -> None:
        # Switching channel with /model changes only the stdin model id; the
        # launcher's selector env still names the channel the session booted on.
        payload = {
            "model": {
                "id": "anthropic/glm,glm-5.2",
                "display_name": "[glm] glm-5.2",
            }
        }
        env = {
            "CLAUDE1_SESSION_SOURCE": "hub",
            "CLAUDE1_CHANNEL_SELECTOR": "fable,k3-256k",
            "ANTHROPIC_MODEL": "fable,k3-256k",
        }
        self.assertEqual(statusline.resolve_model(payload, env), "glm-5.2")

    def test_gateway_selector_keeps_slashes_inside_the_model_name(self) -> None:
        payload = {"model": {"id": "anthropic/route-a,Qwen/Qwen3.5-9B"}}
        env = {
            "CLAUDE1_SESSION_SOURCE": "hub",
            "CLAUDE1_CHANNEL_SELECTOR": "fable,k3-256k",
        }
        self.assertEqual(
            statusline.resolve_model(payload, env),
            "Qwen/Qwen3.5-9B",
        )

    def test_tier_placeholder_resolves_to_that_slot_not_the_startup_channel(
        self,
    ) -> None:
        # Picking a slot in /model leaves the id as Anthropic's placeholder, so
        # the tier word is the only link back to the channel it routes to.
        env = {
            "CLAUDE1_SESSION_SOURCE": "hub",
            "CLAUDE1_CHANNEL_SELECTOR": "fable,k3-256k",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "grok,grok-4.5",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "grok-4.5",
            "ANTHROPIC_DEFAULT_FABLE_MODEL": "fable,k3-256k",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "k3-256k",
        }
        self.assertEqual(
            statusline.resolve_model({"model": {"id": "claude-opus-4-8"}}, env),
            "grok-4.5",
        )
        self.assertEqual(
            statusline.resolve_model({"model": {"id": "claude-fable-5"}}, env),
            "k3-256k",
        )

    def test_tier_placeholder_falls_back_to_selector_when_slot_lacks_name(
        self,
    ) -> None:
        env = {"ANTHROPIC_DEFAULT_SONNET_MODEL": "glm,glm-5.2"}
        self.assertEqual(
            statusline.resolve_model({"model": {"id": "claude-sonnet-5"}}, env),
            "glm-5.2",
        )

    def test_official_placeholder_without_any_slot_stays_untouched(self) -> None:
        # A plain Anthropic session defines no slots: the id must survive so the
        # layout can render it as the official tier name.
        self.assertEqual(
            statusline.resolve_model({"model": {"id": "claude-opus-4-8"}}, {}),
            "claude-opus-4-8",
        )

    def test_gateway_selector_needs_both_alias_and_model(self) -> None:
        env = {
            "CLAUDE1_SESSION_SOURCE": "hub",
            "CLAUDE1_CHANNEL_SELECTOR": "fable,k3-256k",
        }
        for incomplete in ("anthropic/,glm-5.2", "anthropic/glm,", "claude-opus-5"):
            with self.subTest(model_id=incomplete):
                payload = {"model": {"id": incomplete}}
                self.assertEqual(
                    statusline.resolve_model(payload, env),
                    "k3-256k",
                )

    def test_missing_stdin_id_falls_back_to_process_model(self) -> None:
        payload = {"model": {"display_name": "Logical tier"}}
        self.assertEqual(
            statusline.resolve_model(
                payload,
                {"ANTHROPIC_MODEL": "configured-startup-model"},
            ),
            "configured-startup-model",
        )

    def test_db_current_mapping_requires_exactly_one_current_row(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Path(raw) / "cc-switch.db"
            connection = sqlite3.connect(db)
            connection.execute(
                "CREATE TABLE providers ("
                "id TEXT, app_type TEXT, settings_config TEXT, is_current INTEGER)"
            )
            connection.execute(
                "INSERT INTO providers VALUES (?, 'claude', ?, 1)",
                (
                    "current",
                    json.dumps(
                        {
                            "env": {
                                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "slot-id",
                                "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "DB Model",
                            }
                        }
                    ),
                ),
            )
            connection.commit()
            connection.close()
            payload = {"model": {"id": "slot-id", "display_name": "Haiku"}}
            env = {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:19091",
                "CLAUDE1_DB_PATH": str(db),
            }

            self.assertEqual(statusline.resolve_model(payload, env), "DB Model")

    def test_db_connect_failure_returns_empty_without_unbound_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Path(raw) / "cc-switch.db"
            db.touch()

            with (
                mock.patch.object(
                    statusline.sqlite3,
                    "connect",
                    side_effect=sqlite3.OperationalError("cannot connect"),
                ),
                mock.patch.object(
                    statusline,
                    "UnboundLocalError",
                    AssertionError,
                    create=True,
                ),
            ):
                self.assertEqual(statusline._current_provider_env(db), {})


if __name__ == "__main__":
    unittest.main()
