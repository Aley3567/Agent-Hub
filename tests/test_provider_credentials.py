import json
from pathlib import Path
import unittest
from unittest.mock import patch

import claude1_credentials as credentials

FIXTURE = Path(__file__).parent / "fixtures/provider-credential-v1.json"
REF = "provider/v1/00000000-0000-4000-8000-000000000001"


class ProviderCredentialTests(unittest.TestCase):
    def row(self):
        return {"id": "same-id", "credential_ref": REF, "credential_version": 1, "revision": 2}

    def test_fixture_and_persisted_metadata_remain_separate(self):
        settings = {"env": {"ANTHROPIC_BASE_URL": "https://example.test", "ANTHROPIC_AUTH_TOKEN": "stale"}}
        result, _ = credentials.resolve(self.row(), "claude", settings, reader=lambda _: FIXTURE.read_bytes())
        self.assertEqual(result["env"]["ANTHROPIC_AUTH_TOKEN"], "fake-selected-token")
        self.assertEqual(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "stale")
        self.assertEqual(result["env"]["ANTHROPIC_BASE_URL"], "https://example.test")

    def test_identity_revision_version_and_shapes_fail_closed(self):
        raw = FIXTURE.read_bytes()
        for app, identity, revision in [("codex", "same-id", 2), ("claude", "other", 2), ("claude", "same-id", 3)]:
            with self.assertRaisesRegex(credentials.CredentialError, "credential_corrupt"):
                credentials.decode_envelope(raw, app, identity, revision)
        for raw in [b"fake-secret", b"[]", b"null", b'{"version":true}',
                    FIXTURE.read_bytes().replace(b'"version": 1', b'"version": 1, "version": 1'),
                    FIXTURE.read_bytes().replace(b'"meta": {}', b'"meta": {"n": NaN}')]:
            with self.assertRaisesRegex(credentials.CredentialError, "^credential_corrupt$"):
                credentials.decode_envelope(raw, "claude", "same-id", 2)

    def test_reference_errors_never_fall_back_to_plaintext(self):
        for code in ["credential_missing", "credential_denied", "credential_locked", "credential_timeout", "credential_corrupt"]:
            with patch.object(credentials, "read_secret", side_effect=credentials.CredentialError(code)):
                with self.assertRaisesRegex(credentials.CredentialError, code):
                    credentials.resolve(self.row(), "claude", {"env": {"ANTHROPIC_AUTH_TOKEN": "stale"}})

    def test_reference_payload_is_authoritative_across_auth_aliases(self):
        payload = json.loads(FIXTURE.read_bytes())
        payload["settings"] = {"env": {"ANTHROPIC_API_KEY": "fake-new-key"}}
        result, _ = credentials.resolve(self.row(), "claude", {"env": {
            "ANTHROPIC_AUTH_TOKEN": "fake-old-token", "HTTPS_PROXY": "http://fake-user:fake-password@localhost",  # secret-guard: allow embedded-url-credential
            "ANTHROPIC_BASE_URL": "https://example.test"}}, reader=lambda _: json.dumps(payload).encode())
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", result["env"])
        self.assertNotIn("HTTPS_PROXY", result["env"])
        self.assertEqual(result["env"]["ANTHROPIC_API_KEY"], "fake-new-key")

    def test_legacy_read_does_not_contact_os_and_warns_once(self):
        events = []
        row = {"id": "legacy-test", "revision": 0}
        settings = {"auth": {"OPENAI_API_KEY": "fake-legacy"}}
        with patch.object(credentials, "read_secret", side_effect=AssertionError):
            for _ in range(2):
                result, _ = credentials.resolve(row, "codex", settings, warning=events.append)
                self.assertEqual(result, settings)
        self.assertEqual(len(events), 1)
        self.assertNotIn("synthetic", json.dumps(events))

    def test_linux_is_explicitly_unavailable(self):
        with patch.object(credentials.platform, "system", return_value="Linux"), patch.object(credentials.subprocess, "run", side_effect=AssertionError):
            with self.assertRaisesRegex(credentials.CredentialError, "credential_unavailable"):
                credentials.read_secret(REF)

    def test_os_status_is_distinguished_without_echoing_stderr(self):
        import subprocess
        for status, expected in [(-25300, "missing"), (-25293, "denied"), (-25308, "locked"), (-26275, "corrupt"), (-25291, "unavailable")]:
            result = subprocess.CompletedProcess([], 1, b"", f"fake-secret\nfind-generic-password: returned {status}\n".encode())
            with patch.object(credentials.platform, "system", return_value="Darwin"), patch.object(credentials.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(credentials.CredentialError, f"^credential_{expected}$"):
                    credentials.read_secret(REF)
