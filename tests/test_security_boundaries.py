"""Credential boundaries exercised without external services or real secrets."""
import asyncio
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from aiohttp import web
from multidict import CIMultiDict

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from claude_hub import credentials
from claude_hub.domain import normalize_base_url
from claude_hub.launch import launch_standalone_session
from claude_hub.quick_setup import create_standalone_profile
from claude_hub.standalone import StandaloneProfileStore

SPEC = importlib.util.spec_from_file_location("security_hub_runtime", ROOT / "claude-hub.py")
hub = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hub)


class ForwardingCredentialTests(unittest.TestCase):
    def test_client_cookies_do_not_cross_provider_boundary(self):
        headers = CIMultiDict({"Cookie": "local_session=fixture", "Cookie2": "legacy=fixture",
                                "anthropic-version": "2023-06-01", "x-request-id": "request-1"})
        forwarded = hub.upstream_headers(SimpleNamespace(headers=headers), "selected-fixture")
        self.assertNotIn("cookie", forwarded)
        self.assertNotIn("cookie2", forwarded)
        self.assertEqual(forwarded["authorization"], "Bearer selected-fixture")  # secret-guard: allow literal-bearer-token
        self.assertEqual(forwarded["anthropic-version"], "2023-06-01")
        self.assertEqual(forwarded["x-request-id"], "request-1")

    def test_upstream_session_does_not_reuse_cookies_between_origins(self):
        async def run():
            seen = []

            async def endpoint(request):
                seen.append(request.headers.get("Cookie"))
                response = web.Response(text="ok")
                response.set_cookie("provider_session", "fixture")
                return response

            runners, urls = [], []
            app = web.Application()
            context = hub._client_session_context(app)
            try:
                for _ in range(2):
                    upstream = web.Application()
                    upstream.router.add_get("/", endpoint)
                    runner = web.AppRunner(upstream)
                    runners.append(runner)
                    await runner.setup()
                    site = web.TCPSite(runner, "127.0.0.1", 0)
                    await site.start()
                    port = site._server.sockets[0].getsockname()[1]
                    urls.append(f"http://localhost:{port}/")
                await anext(context)
                session = app[hub.UPSTREAM_SESSION_KEY]
                for url in [urls[0], urls[1], urls[0]]:
                    async with session.get(url) as response:
                        await response.read()
                self.assertEqual(seen, [None, None, None])
                self.assertEqual(len(session.cookie_jar), 0)
            finally:
                await context.aclose()
                for runner in runners:
                    await runner.cleanup()
        asyncio.run(run())


class StandaloneCredentialTests(unittest.TestCase):
    def test_inherited_authentication_cannot_override_selected_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StandaloneProfileStore(Path(directory))
            secrets = credentials.InMemorySecretStore()
            profile = create_standalone_profile(store, secrets, name="Fixture",
                base_url="https://provider.example/v1", secret="selected-fixture")  # secret-guard: allow generic-secret-assignment
            inherited = {"ANTHROPIC_AUTH_TOKEN": "old-fixture", "CLAUDE_CODE_OAUTH_TOKEN": "old-oauth",
                         "ANTHROPIC_API_KEY": "old-key", "PATH": "/bin", "CUSTOM_SETTING": "preserved"}
            captured = {}

            def runner(cmd, env):
                captured.update(env)
                return 0

            launch_standalone_session(store, secrets, profile.profile_id, claude_bin="/bin/echo",
                                      runner=runner, environ=inherited)
            self.assertNotIn("ANTHROPIC_AUTH_TOKEN", captured)
            self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", captured)
            self.assertEqual(captured["ANTHROPIC_API_KEY"], "selected-fixture")
            self.assertEqual(captured["CUSTOM_SETTING"], "preserved")
            self.assertEqual(inherited["ANTHROPIC_AUTH_TOKEN"], "old-fixture")

    def test_remote_cleartext_endpoint_is_rejected_before_secret_write(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StandaloneProfileStore(Path(directory))
            secrets = credentials.InMemorySecretStore()
            for url in ["http://provider.example/v1", "http://192.168.1.20/v1", "http://127.1/v1"]:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    create_standalone_profile(store, secrets, name="Fixture", base_url=url,
                                              secret="selected-fixture")  # secret-guard: allow generic-secret-assignment
            self.assertEqual(secrets.list_secret_refs(), ())

    def test_loopback_http_and_public_https_remain_supported(self):
        for url in ["http://localhost:8080/v1/", "http://127.0.0.1:8080/v1/",
                    "http://[::1]:8080/v1/", "https://provider.example/v1/"]:
            with self.subTest(url=url):
                self.assertEqual(normalize_base_url(url), url.rstrip("/"))

    def test_invalid_endpoint_host_and_port_are_rejected(self):
        for url in ["https://:443/v1", "https://provider.example:99999/v1", "https://provider.example:0/v1"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                normalize_base_url(url)

    def test_keychain_write_keeps_password_out_of_process_arguments(self):
        secret = 'fixture "quoted" \\ value\nnext-line'
        store = credentials.MacOSKeychainStore()
        result = subprocess.CompletedProcess([], 0, "", "")
        readback = subprocess.CompletedProcess([], 0, "", f'password: 0x{secret.encode().hex()}\n')
        with patch.object(store, "is_available", return_value=True), patch.object(
                credentials.subprocess, "run", side_effect=[result, readback]) as run:
            store.set_secret(uuid4(), secret)
        args, kwargs = run.call_args_list[0]
        self.assertEqual(args[0], ["/usr/bin/security", "-i"])
        self.assertNotIn(secret, repr(args))
        self.assertIn(secret.encode().hex(), kwargs["input"])
        self.assertEqual(kwargs["input"].count("\n"), 1)
        self.assertIn("timeout", kwargs)

    def test_keychain_failure_does_not_echo_backend_output(self):
        store = credentials.MacOSKeychainStore()
        result = subprocess.CompletedProcess([], 1, "", "private-fixture-in-backend-error")
        with patch.object(store, "is_available", return_value=True), patch.object(
                credentials.subprocess, "run", return_value=result):
            with self.assertRaises(credentials.SecretStoreError) as caught:
                store.set_secret(uuid4(), "selected-fixture")
        self.assertNotIn("private-fixture", str(caught.exception))

    def test_keychain_line_limit_and_invalid_secret_fail_before_spawn(self):
        store = credentials.MacOSKeychainStore()
        with patch.object(store, "is_available", return_value=True), patch.object(
                credentials.subprocess, "run") as run:
            for secret in ["x" * 3000, "nul\x00value"]:
                with self.subTest(length=len(secret)), self.assertRaises(ValueError):
                    store.set_secret(uuid4(), secret)
            run.assert_not_called()
