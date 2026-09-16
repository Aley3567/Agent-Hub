"""Credential behavior at real database/launcher boundaries; all secrets are fixtures."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import claude1_credentials as credentials
import claude1_providers as providers
from test_launcher import loaded_launcher, isolated_env
from test_codex_provider_once import loaded_launcher as loaded_codex

ROOT = Path(__file__).resolve().parents[1]
REF_A = "provider/v1/00000000-0000-4000-8000-000000000001"
REF_B = "provider/v1/00000000-0000-4000-8000-000000000002"


def envelope(app="claude", revision=1, token="fake-selected-key"):
    settings = {"env": {"ANTHROPIC_AUTH_TOKEN": token}} if app == "claude" else {"auth": {"OPENAI_API_KEY": token}}
    return json.dumps({"version": 1, "app_type": app, "provider_id": "same-id", "revision": revision,
                       "settings": settings, "meta": {}}).encode()


def database(path, app="claude"):
    conn = sqlite3.connect(path)
    conn.executescript((ROOT / "provider-schema.sql").read_text())
    settings = {"env": {"ANTHROPIC_BASE_URL": "https://example.test", "ANTHROPIC_MODEL": "fixture-model",
                        "CLAUDE_CODE_SUBAGENT_MODEL": "fixture-pinned"}}
    if app == "codex":
        settings = {"config": 'model_provider="selected"\nmodel="fixture-model"\n[model_providers.selected]\nname="Selected"\nbase_url="https://example.test/v1"\nwire_api="responses"\n'}
    conn.execute("INSERT INTO providers(id,app_type,name,settings_config,credential_ref,credential_version,revision) VALUES(?,?,?,?,?,1,1)",
                 ("same-id", app, "Fixture", json.dumps(settings), REF_A))
    conn.commit()
    path.chmod(0o600)
    return conn


class ProviderReaderTests(unittest.TestCase):
    def test_claude_auth_transport_and_doctor_keep_persisted_secrets_absent(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            env = isolated_env(home)
            path = Path(env["CLAUDE1_DB_PATH"])
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = database(path)
            # Same ID in another application must not be rewritten by doctor.
            conn.execute("INSERT INTO providers(id,app_type,name,settings_config) VALUES('same-id','codex','Other','{}')")
            conn.commit()
            with loaded_launcher(env) as launcher, patch.object(credentials, "read_secret", return_value=envelope()) as read:
                provider = launcher._provider_from_row(launcher.db_claude_rows()[0])
                settings = launcher.build_settings(provider)
                self.assertEqual(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "fake-selected-key")
                self.assertEqual(launcher._provider_account_credential(provider)[1], "fake-selected-key")
                calls = read.call_count
                changed, invalid, _ = launcher.fix_subagent_model_overrides()
                self.assertEqual(changed, ["Fixture"])
                self.assertEqual(invalid, [])
                self.assertEqual(read.call_count, calls)
            rows = conn.execute("SELECT app_type,settings_config,credential_ref FROM providers ORDER BY app_type").fetchall()
            self.assertNotIn("fake-selected-key", str(rows))
            self.assertNotIn("CLAUDE_CODE_SUBAGENT_MODEL", rows[0][1])
            self.assertEqual(rows[0][2], REF_A)
            self.assertEqual(rows[1][1], "{}")
            conn.close()

    def test_native_pool_aborts_if_reclaimed_reference_changes_endpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            env = isolated_env(home)
            path = Path(env["CLAUDE1_DB_PATH"])
            path.parent.mkdir(parents=True)
            conn = database(path)
            Path(env["CLAUDE1_ACCOUNT_POOL_CONFIG"]).write_text(json.dumps({
                "version": 1, "providers": {"id:same-id": {
                    "strategy": "round_robin", "members": [{"provider": "id:same-id"}]
                }}
            }))
            Path(env["CLAUDE1_ACCOUNT_POOL_CONFIG"]).chmod(0o600)
            with loaded_launcher(env) as launcher:
                provider = launcher._provider_from_row(launcher.db_claude_rows()[0])
                with patch.object(credentials, "read_secret", return_value=envelope()):
                    settings = launcher.build_settings(provider)
                rotated = {"env": {"ANTHROPIC_BASE_URL": "https://rotated.test",
                                   "ANTHROPIC_MODEL": "rotated-model"}}
                conn.execute("UPDATE providers SET credential_ref=?, revision=2, settings_config=?",
                             (REF_B, json.dumps(rotated)))
                conn.commit()
                def read(reference):
                    if reference == REF_A:
                        raise credentials.CredentialError("credential_missing")
                    return envelope(revision=2, token="fake-rotated-key")
                with patch.object(credentials, "read_secret", side_effect=read):
                    with self.assertRaisesRegex(RuntimeError, "provider_changed"):
                        launcher.apply_native_account_pool(provider, settings)
                self.assertEqual(settings["env"]["ANTHROPIC_BASE_URL"], "https://example.test")
                self.assertEqual(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "fake-selected-key")
            conn.close()

    def test_codex_new_schema_listing_is_metadata_only_and_launch_resolves(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "providers.db"
            conn = database(path, "codex")
            with loaded_codex({"CODEX1_DB_PATH": str(path)}) as launcher:
                with patch.object(credentials, "read_secret", side_effect=AssertionError("listing accessed secrets")):
                    rows = launcher.list_providers()
                    self.assertEqual(rows[0]["credential_ref"], REF_A)
                    self.assertEqual(launcher.provider_summary(rows[0])[1], "https://example.test/v1")
                with patch.object(credentials, "read_secret", return_value=envelope("codex")):
                    auth, config = launcher.provider_settings(rows[0])
                    self.assertEqual(launcher.build_profile(config, auth)["api_key"], "fake-selected-key")
            conn.close()

    def test_snapshot_rotation_uses_new_token_without_per_request_secret_reads(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "providers.db"
            conn = database(path)
            cache = providers.ProviderSnapshotCache()
            def refresh():
                records, revision = providers._read_provider_snapshot(path)
                return revision, records, 0
            with patch.object(credentials, "read_secret", side_effect=lambda ref: envelope(revision=1) if ref == REF_A else envelope(revision=2, token="fake-rotated-key")) as read:
                first = cache.load(providers._database_snapshot_state(path), refresh)
                self.assertEqual(first["id:same-id"]["token"], "fake-selected-key")
                cache.load(providers._database_snapshot_state(path), refresh)
                self.assertEqual(read.call_count, 1)
                conn.execute("UPDATE providers SET credential_ref=?,revision=2", (REF_B,)); conn.commit()
                second = cache.load(providers._database_snapshot_state(path), refresh)
                self.assertEqual(second["id:same-id"]["token"], "fake-rotated-key")
                self.assertEqual(second["id:same-id"]["credential_revision"], 2)
                self.assertEqual(read.call_count, 2)
            conn.close()

    def test_reclaimed_snapshot_reference_reloads_once_before_request(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "providers.db"
            conn = database(path)
            def read(reference):
                if reference == REF_A:
                    conn.execute("UPDATE providers SET credential_ref=?,revision=2", (REF_B,)); conn.commit()
                    raise credentials.CredentialError("credential_missing")
                return envelope(revision=2, token="fake-rotated-key")
            with patch.object(credentials, "read_secret", side_effect=read) as mocked:
                result, _ = providers._read_provider_snapshot(path)
                self.assertEqual(result["id:same-id"]["token"], "fake-rotated-key")
                self.assertEqual(mocked.call_count, 2)
            conn.close()

    def test_failed_reference_is_cached_with_bounded_retry_and_no_plaintext(self):
        row = {"id": "same-id", "name": "Fixture", "credential_ref": REF_A,
               "credential_version": 1, "revision": 1,
               "settings_config": json.dumps({"env": {"ANTHROPIC_BASE_URL": "https://example.test", "ANTHROPIC_AUTH_TOKEN": "fake-stale-token"}})}
        cache = providers.ProviderSnapshotCache()
        with patch.object(credentials, "read_secret", side_effect=credentials.CredentialError("credential_denied")) as read, patch.object(providers.time, "monotonic", return_value=10):
            def refresh():
                record = providers._provider_record(row)[2]
                return (1,), {"id:same-id": record}, 0
            result = cache.load((1,), refresh)
            self.assertEqual(result["id:same-id"]["credential_error"], "credential_denied")
            self.assertEqual(result["id:same-id"]["token"], "")
            self.assertNotIn("fake-stale-token", str(result))
            cache.load((1,), refresh)
            self.assertEqual(read.call_count, 1)
        with patch.object(credentials, "read_secret", return_value=envelope()), patch.object(providers.time, "monotonic", return_value=13):
            self.assertEqual(cache.load((1,), refresh)["id:same-id"]["token"], "fake-selected-key")
