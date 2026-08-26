"""Versioned JSON command surface for agent callers."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TextIO
from uuid import UUID

from . import __version__
from .ccswitch import CCSwitchProviderStore
from .credentials import (
    SecretStore,
    SecretStoreError,
    SecretStoreUnavailableError,
    build_default_secret_store,
)
from .domain import ModelMapping, ProtocolAdapter, StoreCapability
from .launch import launch_standalone_session
from .quick_setup import (
    audit_orphan_secrets,
    cleanup_orphan_secrets,
    create_standalone_profile,
    delete_standalone_profile,
)
from .service import ProviderApplicationService
from .standalone import (
    StandaloneProfileConflictError,
    StandaloneProfileExistsError,
    StandaloneProfileNotFoundError,
    StandaloneProfileStore,
    StandaloneStoreCorruptError,
    StandaloneStoreError,
    StandaloneStoreSecurityError,
    standalone_data_dir,
)
from .store import (
    ProviderConfigCorruptError,
    ProviderNotFoundError,
    ProviderStoreIncompatibleError,
    ProviderStoreUnavailableError,
)


SCHEMA_VERSION = 1
EXIT_OK = 0
EXIT_RUNTIME_ERROR = 1
EXIT_USAGE = 2

_USAGE = "switchctl detect"
_HELP_USAGE = (
    _USAGE,
    "switchctl list",
    "switchctl inspect <stable-id>",
    "switchctl mode [--store standalone]",
    "switchctl route [--store standalone]",
    "switchctl profile list",
    "switchctl profile create --name <name> --base-url <url> [--adapter <adapter>] [--models <json>] [--secret <key> | --secret-stdin]",
    "switchctl profile inspect <id>",
    "switchctl profile delete <id> [--keep-secret]",
    "switchctl profile audit-orphans",
    "switchctl launch <profile-id>",
)
_COMMAND_USAGE = {
    "detect": _USAGE,
    "list": "switchctl list",
    "inspect": "switchctl inspect <stable-id>",
    "mode": "switchctl mode [--store standalone]",
    "route": "switchctl route [--store standalone]",
    "profile": "switchctl profile <list|create|inspect|delete|audit-orphans>",
    "launch": "switchctl launch <profile-id>",
}


class _EnvelopeArgumentParser(argparse.ArgumentParser):
    """ArgumentParser that raises ValueError instead of calling sys.exit."""

    def error(self, message: str) -> None:
        raise ValueError(message)


def build_default_service() -> ProviderApplicationService:
    """Build the read-only CC Switch service for installed commands."""
    return ProviderApplicationService(CCSwitchProviderStore())


def build_default_profile_store() -> StandaloneProfileStore:
    """Build default StandaloneProfileStore at standard platform path."""
    data_dir = standalone_data_dir(platform.system(), home=Path.home())
    return StandaloneProfileStore(data_dir)


def _envelope(
    *,
    ok: bool,
    data: dict[str, object] | None,
    error: dict[str, str] | None,
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "ok": ok,
        "data": data,
        "error": error,
    }


def _write_json(stream: TextIO, payload: dict[str, object]) -> None:
    json.dump(
        payload,
        stream,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    stream.write("\n")


def _write_error(
    output: TextIO,
    diagnostics: TextIO,
    *,
    code: str,
    message: str,
) -> None:
    _write_json(
        output,
        _envelope(
            ok=False,
            data=None,
            error={"code": code, "message": message},
        ),
    )
    diagnostics.write(f"switchctl: {code}\n")


def _usage_for(arguments: tuple[object, ...]) -> str:
    if arguments and isinstance(arguments[0], str):
        return _COMMAND_USAGE.get(arguments[0], _USAGE)
    return _USAGE


def _handle_profile_command(
    args: tuple[str, ...],
    profile_store: StandaloneProfileStore,
    secret_store: SecretStore,
    *,
    stdin: TextIO | None = None,
) -> dict[str, object]:
    if not args:
        raise ValueError("missing profile subcommand")

    subcmd = args[0]
    if subcmd == "list":
        profiles = profile_store.list()
        items: list[dict[str, object]] = []
        for p in profiles:
            items.append(
                {
                    "profileId": str(p.profile_id),
                    "name": p.name,
                    "baseUrl": p.base_url,
                    "adapter": p.adapter.value,
                    "models": p.models.to_public_dict(),
                    "createdAt": p.created_at.isoformat(),
                    "updatedAt": p.updated_at.isoformat(),
                }
            )
        return {"profiles": items}

    if subcmd == "inspect":
        if len(args) < 2:
            raise ValueError("missing profile id")
        p = profile_store.get(args[1])
        return {
            "profileId": str(p.profile_id),
            "name": p.name,
            "baseUrl": p.base_url,
            "adapter": p.adapter.value,
            "models": p.models.to_public_dict(),
            "createdAt": p.created_at.isoformat(),
            "updatedAt": p.updated_at.isoformat(),
            "hasSecret": secret_store.is_available() and secret_store.get_secret(p.secret_ref) is not None,
        }

    if subcmd == "create":
        parser = _EnvelopeArgumentParser(prog="switchctl profile create", add_help=False)
        parser.add_argument("--name", required=True)
        parser.add_argument("--base-url", required=True)
        parser.add_argument("--secret", default=None)
        parser.add_argument("--secret-stdin", action="store_true", default=False)
        parser.add_argument("--adapter", default="anthropic")
        parser.add_argument("--models", default=None)

        parsed_args = parser.parse_args(args[1:])

        secret_value = parsed_args.secret
        if parsed_args.secret_stdin or secret_value == "-":
            in_stream = sys.stdin if stdin is None else stdin
            secret_value = in_stream.read().strip()

        if not secret_value:
            raise ValueError("secret is required (pass via --secret or --secret-stdin)")

        models_obj = None
        if parsed_args.models:
            try:
                m_dict = json.loads(parsed_args.models)
                models_obj = ModelMapping(**m_dict)
            except Exception as exc:
                raise ValueError(f"invalid models JSON: {exc}") from exc

        profile = create_standalone_profile(
            profile_store,
            secret_store,
            name=parsed_args.name,
            base_url=parsed_args.base_url,
            secret=secret_value,
            adapter=ProtocolAdapter(parsed_args.adapter.lower()),
            models=models_obj,
        )
        return {
            "profileId": str(profile.profile_id),
            "name": profile.name,
            "baseUrl": profile.base_url,
            "adapter": profile.adapter.value,
            "createdAt": profile.created_at.isoformat(),
        }

    if subcmd == "delete":
        if len(args) < 2:
            raise ValueError("missing profile id")
        profile_id = args[1]
        keep_secret = "--keep-secret" in args
        deleted = delete_standalone_profile(
            profile_store,
            secret_store,
            profile_id,
            purge_secret=not keep_secret,
        )
        return {"profileId": str(profile_id), "deleted": deleted}

    if subcmd == "audit-orphans":
        orphans = audit_orphan_secrets(profile_store, secret_store)
        return {"orphanSecretCount": len(orphans), "orphanSecretRefs": list(orphans)}

    raise ValueError(f"unknown profile subcommand: {subcmd}")


def main(
    argv: Sequence[str] | None = None,
    *,
    service: ProviderApplicationService | None = None,
    profile_store: StandaloneProfileStore | None = None,
    secret_store: SecretStore | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    standalone_exists: bool = False,
    runner: Any | None = None,
) -> int:
    """Run ``switchctl`` with injectable argv, service, and output streams."""

    arguments = tuple(sys.argv[1:] if argv is None else argv)
    output = sys.stdout if stdout is None else stdout
    diagnostics = sys.stderr if stderr is None else stderr

    if arguments in {("-h",), ("--help",), ("help",)}:
        _write_json(
            output,
            _envelope(
                ok=True,
                data={
                    "usage": list(_HELP_USAGE),
                    "version": __version__,
                },
                error=None,
            ),
        )
        return EXIT_OK

    if arguments in {("-v",), ("--version",), ("version",)}:
        _write_json(
            output,
            _envelope(
                ok=True,
                data={"version": __version__},
                error=None,
            ),
        )
        return EXIT_OK

    command = None
    stable_id = None
    store_override = None
    profile_args: tuple[str, ...] = ()
    launch_id = None

    if arguments == ("detect",):
        command = "detect"
    elif arguments == ("list",):
        command = "list"
    elif len(arguments) == 2 and arguments[0] == "inspect":
        command = "inspect"
        stable_id = arguments[1]
    elif arguments in {("mode",), ("route",)}:
        command = "mode"
    elif arguments in {
        ("mode", "--store", "standalone"),
        ("route", "--store", "standalone"),
        ("--store", "standalone", "mode"),
        ("--store", "standalone", "route"),
    }:
        command = "mode"
        store_override = "standalone"
    elif arguments and arguments[0] == "profile":
        command = "profile"
        profile_args = arguments[1:]
    elif len(arguments) == 2 and arguments[0] == "launch":
        command = "launch"
        launch_id = arguments[1]
    else:
        _write_error(
            output,
            diagnostics,
            code="usage_error",
            message=f"usage: {_usage_for(arguments)}",
        )
        return EXIT_USAGE

    try:
        application = build_default_service() if service is None else service
        prof_store = build_default_profile_store() if profile_store is None else profile_store
        sec_store = build_default_secret_store() if secret_store is None else secret_store

        if command == "detect":
            capability = application.detect()
            data: dict[str, object] = {"capability": capability.value}
        elif command == "list":
            providers: list[dict[str, object]] = []
            for reference in application.list():
                item: dict[str, object] = {
                    "stableId": reference.provider_id,
                    "current": reference.is_current,
                }
                if reference.display_name is not None:
                    item["displayName"] = reference.display_name
                providers.append(item)
            data = {"providers": providers}
        elif command == "inspect":
            if stable_id is None:
                raise ValueError("stable id is missing")
            inspection = application.inspect_stable_id(stable_id)
            if (
                inspection.fingerprint is None
                or inspection.schema_capability is None
                or inspection.unknown_fingerprint is None
            ):
                raise ValueError("inspection summary is incomplete")
            data = {
                "stableId": inspection.reference.provider_id,
                "models": inspection.models.to_public_dict(),
                "configurationFingerprint": inspection.fingerprint,
                "current": inspection.is_current,
                "proxyTakeover": inspection.proxy_takeover,
                "schemaCapability": inspection.schema_capability.value,
                "unknownFields": {
                    "count": inspection.unknown_field_count,
                    "fingerprint": inspection.unknown_fingerprint,
                },
            }
        elif command == "profile":
            data = _handle_profile_command(
                profile_args,
                prof_store,
                sec_store,
                stdin=stdin,
            )
        elif command == "launch":
            if launch_id is None:
                raise ValueError("launch profile id is missing")
            outcome = launch_standalone_session(
                prof_store,
                sec_store,
                launch_id,
                runner=runner,
            )
            data = {
                "profileId": str(outcome.profile_id),
                "exitCode": outcome.exit_code,
                "sessionId": outcome.session_id,
                "isolated": outcome.isolated,
            }
        else:
            has_standalone = standalone_exists or prof_store.has_profiles()
            route = application.resolve_startup(
                standalone_exists=has_standalone,
                store_override=store_override,
            )
            data = {
                "mode": route.mode.value,
                "firstScreen": route.first_screen.value,
            }
    except StandaloneProfileNotFoundError:
        _write_error(
            output,
            diagnostics,
            code="profile_not_found",
            message="standalone profile was not found",
        )
        return EXIT_RUNTIME_ERROR
    except (StandaloneProfileExistsError, StandaloneProfileConflictError) as exc:
        _write_error(
            output,
            diagnostics,
            code="profile_conflict",
            message=str(exc),
        )
        return EXIT_RUNTIME_ERROR
    except SecretStoreUnavailableError:
        _write_error(
            output,
            diagnostics,
            code="secret_store_unavailable",
            message="system credential store is unavailable",
        )
        return EXIT_RUNTIME_ERROR
    except SecretStoreError as exc:
        _write_error(
            output,
            diagnostics,
            code="secret_store_error",
            message=str(exc),
        )
        return EXIT_RUNTIME_ERROR
    except StandaloneStoreSecurityError as exc:
        _write_error(
            output,
            diagnostics,
            code="store_security_error",
            message=str(exc),
        )
        return EXIT_RUNTIME_ERROR
    except StandaloneStoreCorruptError:
        _write_error(
            output,
            diagnostics,
            code="store_corrupt",
            message="standalone store is corrupt",
        )
        return EXIT_RUNTIME_ERROR
    except ProviderConfigCorruptError:
        _write_error(
            output,
            diagnostics,
            code="provider_config_corrupt",
            message="provider configuration is invalid",
        )
        return EXIT_RUNTIME_ERROR
    except ProviderNotFoundError:
        _write_error(
            output,
            diagnostics,
            code="provider_not_found",
            message="provider reference was not found",
        )
        return EXIT_RUNTIME_ERROR
    except ProviderStoreUnavailableError:
        _write_error(
            output,
            diagnostics,
            code="store_unavailable",
            message="provider store is unavailable",
        )
        return EXIT_RUNTIME_ERROR
    except ProviderStoreIncompatibleError:
        _write_error(
            output,
            diagnostics,
            code="store_incompatible",
            message="provider store schema is incompatible",
        )
        return EXIT_RUNTIME_ERROR
    except Exception as exc:
        _write_error(
            output,
            diagnostics,
            code="runtime_error",
            message=f"{command} failed: {exc}",
        )
        return EXIT_RUNTIME_ERROR

    _write_json(
        output,
        _envelope(
            ok=True,
            data=data,
            error=None,
        ),
    )
    return EXIT_OK


run = main


__all__ = [
    "EXIT_OK",
    "EXIT_RUNTIME_ERROR",
    "EXIT_USAGE",
    "SCHEMA_VERSION",
    "build_default_profile_store",
    "build_default_service",
    "main",
    "run",
]
