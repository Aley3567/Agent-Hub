"""Context window resolution for Claude Code model slots.

Claude Code decides a session's context window **client-side**, before any byte
reaches an upstream: the number drives auto-compact and the context meter.  A
window that overstates the upstream's real capacity is worse than one that
understates it, because the client stops compacting and the upstream answers
``400 prompt is too long`` instead.

Three mechanisms exist in the CLI, with different scopes.  Names in parentheses
are the minified identifiers in the Claude Code binary, kept here so the next
reader can re-verify against a new release:

1. ``[1m]`` model-name suffix (``Ov`` → ``JAu``).  A plain regex over the model
   string; it does **not** consult the model registry.  It forces the window to
   1M for *any* model id, third-party ones included.  This is the trap: the
   suffix only changes what the client believes.
2. ``anthropic-beta: context-1m-2025-08-07`` (``EW``).  Enabled when the
   registry says ``supports_1m_beta``, or, for unrecognised models, when the
   provider is first-party/Bedrock/Foundry/Mantle.  A custom ``ANTHROPIC_BASE_URL``
   is none of those, so the header is **not** sent through a third-party gateway.
3. ``CLAUDE_CODE_MAX_CONTEXT_TOKENS`` (``JAu``).  An exact token count, and the
   only mechanism that can express a non-1M window such as 256k.  It is ignored
   for any model whose stripped id starts with ``claude-``.

``modelOverrides`` also exists but is read from ``policySettings`` and only when
``availableModels`` is set, i.e. system-wide managed settings; it is out of scope
for per-provider launches.  ``CLAUDE_CODE_DISABLE_1M_CONTEXT`` disables 1 and 2
wholesale (``sae``).

The module is pure and dependency-free on purpose: the launcher, the Hub and a
future TUI must reach the same verdict from the same inputs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Matrix below was extracted from this CLI build.  ``tools/extract_1m_matrix.py``
# re-extracts it and ``--check`` reports when the installed CLI has moved on.
MATRIX_CLI_VERSION = "2.1.229"

ONE_M = 1_000_000
# ``Xbr``: the window the CLI assumes for a model it does not recognise.
DEFAULT_UNKNOWN_WINDOW = 200_000
SUFFIX = "[1m]"
MAX_CONTEXT_TOKENS_ENV = "CLAUDE_CODE_MAX_CONTEXT_TOKENS"
CONTEXT_1M_BETA = "context-1m-2025-08-07"

_SUFFIX_RE = re.compile(r"(\[1m\])+$", re.IGNORECASE)

# Provider kinds that can actually deliver the context-1m beta (``_W``).  Any
# other kind, including every custom base URL, cannot.
BETA_CAPABLE_PROVIDERS = frozenset(
    {"firstParty", "bedrock", "vertex", "foundry", "mantle"}
)


@dataclass(frozen=True)
class ModelContext:
    """One row of the CLI's built-in ``context:{...}`` block."""

    window: int
    native_1m: bool = False
    supports_1m_beta: bool = False
    supports_1m_suffix: bool = False
    native_1m_3p: bool = False


CONTEXT_MATRIX: dict[str, ModelContext] = {
    "claude-haiku-4-5": ModelContext(200_000, supports_1m_suffix=True),
    "claude-sonnet-4-0": ModelContext(
        200_000, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-sonnet-4-5": ModelContext(
        200_000, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-sonnet-4-6": ModelContext(
        200_000, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-sonnet-5": ModelContext(
        ONE_M, native_1m=True, supports_1m_beta=True, native_1m_3p=True
    ),
    "claude-opus-4-0": ModelContext(200_000, supports_1m_suffix=True),
    "claude-opus-4-1": ModelContext(200_000, supports_1m_suffix=True),
    "claude-opus-4-5": ModelContext(200_000, supports_1m_suffix=True),
    "claude-opus-4-6": ModelContext(
        200_000, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-opus-4-7": ModelContext(
        ONE_M, native_1m=True, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-opus-4-8": ModelContext(
        ONE_M, native_1m=True, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-opus-5": ModelContext(
        ONE_M, native_1m=True, supports_1m_beta=True, supports_1m_suffix=True
    ),
    "claude-fable-5": ModelContext(ONE_M, native_1m=True, supports_1m_beta=True),
    "claude-mythos-5": ModelContext(ONE_M, native_1m=True, supports_1m_beta=True),
}

# Source of the window figure, most authoritative first.
SOURCE_REGISTRY = "registry"
SOURCE_DECLARED = "declared"
SOURCE_PROBED = "probed"
SOURCE_SUFFIX = "suffix"
SOURCE_ASSUMED = "assumed"

# Warning codes.  Stable identifiers so the doctor and the UI can group them
# without matching on prose.
WARN_FAKE_1M = "CTX_FAKE_1M"
WARN_REDUNDANT_SUFFIX = "CTX_REDUNDANT_SUFFIX"
WARN_SUFFIX_WITHOUT_BETA = "CTX_SUFFIX_WITHOUT_BETA"
WARN_UNKNOWN_OFFICIAL = "CTX_UNKNOWN_OFFICIAL_MODEL"
WARN_WINDOW_UNDECLARED = "CTX_WINDOW_UNDECLARED"
WARN_DECLARED_IGNORED = "CTX_DECLARED_IGNORED"


@dataclass(frozen=True)
class ContextNote:
    """One machine-readable finding about a slot's context configuration."""

    code: str
    message: str


@dataclass(frozen=True)
class ContextPlan:
    """What Claude Code will believe, and what to hand it so that is true."""

    model_out: str
    window: int
    source: str
    env: dict[str, str] = field(default_factory=dict)
    notes: tuple[ContextNote, ...] = ()
    beta_reaches_upstream: bool = False

    @property
    def warnings(self) -> tuple[str, ...]:
        return tuple(note.code for note in self.notes)

    def note(self, code: str) -> ContextNote | None:
        for item in self.notes:
            if item.code == code:
                return item
        return None


def strip_suffix(model: str) -> str:
    """Remove any trailing ``[1m]`` markers (``Bo`` for our purposes)."""
    return _SUFFIX_RE.sub("", model.strip())


def has_suffix(model: str) -> bool:
    """Whether the CLI's ``Ov`` regex would treat this id as 1M."""
    return bool(re.search(r"\[1m\]", model, re.IGNORECASE))


def with_suffix(model: str) -> str:
    """Normalise to exactly one trailing marker (``VJ``)."""
    return strip_suffix(model) + SUFFIX


def is_official_id(model: str) -> bool:
    """Whether ``CLAUDE_CODE_MAX_CONTEXT_TOKENS`` would be ignored for this id."""
    return strip_suffix(model).casefold().startswith("claude-")


def registry_entry(model: str) -> ModelContext | None:
    return CONTEXT_MATRIX.get(strip_suffix(model).casefold())


def beta_reaches(provider_kind: str) -> bool:
    return provider_kind in BETA_CAPABLE_PROVIDERS


def resolve_context_window(
    model: str,
    *,
    declared_window: int | None = None,
    probed_window: int | None = None,
    provider_kind: str = "custom",
    want_1m: bool = False,
    disable_1m: bool = False,
) -> ContextPlan:
    """Decide the window for ``model`` and how to make Claude Code agree.

    ``declared_window`` comes from the provider's
    ``claude1_capabilities.context_window``; ``probed_window`` from an upstream
    model listing.  Declared wins, because a human asserted it for this channel.
    Neither is consulted for models the CLI already knows: the registry is
    authoritative there, and the env var would be ignored anyway.

    ``want_1m`` only matters for registry models that reach 1M through the beta
    rather than natively.  Nothing here fabricates a window: when the real one
    is unknown the plan keeps the CLI's own assumption and says so.
    """
    requested_suffix = has_suffix(model)
    bare = strip_suffix(model)
    notes: list[ContextNote] = []

    if disable_1m:
        # ``sae``: the suffix and the beta are both inert, so the honest plan is
        # the bare id with whatever the registry or an exact count provides.
        requested_suffix = False

    entry = registry_entry(bare)

    if entry is not None:
        return _plan_registry_model(
            bare,
            entry,
            requested_suffix=requested_suffix,
            provider_kind=provider_kind,
            want_1m=want_1m,
            declared_window=declared_window,
            probed_window=probed_window,
            notes=notes,
        )

    if is_official_id(bare):
        return _plan_unknown_official_model(
            bare,
            requested_suffix=requested_suffix,
            declared_window=declared_window,
            probed_window=probed_window,
            notes=notes,
        )

    return _plan_third_party_model(
        bare,
        requested_suffix=requested_suffix,
        declared_window=declared_window,
        probed_window=probed_window,
        notes=notes,
    )


def _plan_registry_model(
    bare: str,
    entry: ModelContext,
    *,
    requested_suffix: bool,
    provider_kind: str,
    want_1m: bool,
    declared_window: int | None,
    probed_window: int | None,
    notes: list[ContextNote],
) -> ContextPlan:
    if declared_window is not None or probed_window is not None:
        notes.append(
            ContextNote(
                WARN_DECLARED_IGNORED,
                f"{bare} 在 Claude Code 内建注册表中，窗口由注册表决定"
                f"（{entry.window} token）；声明或探测到的窗口不生效",
            )
        )

    if entry.native_1m:
        if requested_suffix:
            notes.append(
                ContextNote(
                    WARN_REDUNDANT_SUFFIX,
                    f"{bare} 原生 1M（native_1m），[1m] 后缀多余；"
                    "去掉后缀可让模型 ID 与上游一致",
                )
            )
        return ContextPlan(
            model_out=bare,
            window=entry.window,
            source=SOURCE_REGISTRY,
            notes=tuple(notes),
            beta_reaches_upstream=False,
        )

    # A 200k registry model.  The suffix alone always convinces the client, but
    # the upstream only follows when the beta both applies and can be delivered.
    if requested_suffix or want_1m:
        deliverable = entry.supports_1m_beta and beta_reaches(provider_kind)
        if deliverable:
            return ContextPlan(
                model_out=with_suffix(bare),
                window=ONE_M,
                source=SOURCE_SUFFIX,
                notes=tuple(notes),
                beta_reaches_upstream=True,
            )
        if not entry.supports_1m_beta:
            notes.append(
                ContextNote(
                    WARN_SUFFIX_WITHOUT_BETA,
                    f"{bare} 不支持 context-1m beta，加 [1m] 只会让客户端按 1M "
                    f"计算而上游仍是 {entry.window} token；已按注册表窗口处理",
                )
            )
        else:
            notes.append(
                ContextNote(
                    WARN_SUFFIX_WITHOUT_BETA,
                    f"{bare} 需要 context-1m beta 才有 1M，但 provider_kind="
                    f"{provider_kind!r} 不会发送该 header；已按注册表窗口处理",
                )
            )
        return ContextPlan(
            model_out=bare,
            window=entry.window,
            source=SOURCE_REGISTRY,
            notes=tuple(notes),
        )

    return ContextPlan(
        model_out=bare,
        window=entry.window,
        source=SOURCE_REGISTRY,
        notes=tuple(notes),
    )


def _plan_unknown_official_model(
    bare: str,
    *,
    requested_suffix: bool,
    declared_window: int | None,
    probed_window: int | None,
    notes: list[ContextNote],
) -> ContextPlan:
    """An ``claude-*`` id this CLI build does not know.

    ``CLAUDE_CODE_MAX_CONTEXT_TOKENS`` is ignored for the ``claude-`` prefix, so
    an exact window cannot be expressed at all; the suffix is the only lever.
    """
    stated = declared_window or probed_window
    if stated is not None:
        notes.append(
            ContextNote(
                WARN_DECLARED_IGNORED,
                f"{bare} 以 claude- 开头，{MAX_CONTEXT_TOKENS_ENV} 会被 Claude Code "
                f"忽略，声明的 {stated} token 无法生效",
            )
        )
    notes.append(
        ContextNote(
            WARN_UNKNOWN_OFFICIAL,
            f"{bare} 不在本机 Claude Code v{MATRIX_CLI_VERSION} 的模型表中；"
            "窗口只能靠 [1m] 后缀二选一。升级 Claude Code 或重新提取矩阵",
        )
    )
    if requested_suffix:
        return ContextPlan(
            model_out=with_suffix(bare),
            window=ONE_M,
            source=SOURCE_SUFFIX,
            notes=tuple(notes),
        )
    return ContextPlan(
        model_out=bare,
        window=DEFAULT_UNKNOWN_WINDOW,
        source=SOURCE_ASSUMED,
        notes=tuple(notes),
    )


def _plan_third_party_model(
    bare: str,
    *,
    requested_suffix: bool,
    declared_window: int | None,
    probed_window: int | None,
    notes: list[ContextNote],
) -> ContextPlan:
    """A non-``claude-`` id, where an exact window is expressible."""
    window = declared_window if declared_window is not None else probed_window
    source = SOURCE_DECLARED if declared_window is not None else SOURCE_PROBED

    if window is None:
        if requested_suffix:
            notes.append(
                ContextNote(
                    WARN_FAKE_1M,
                    f"{bare}[1m] 让客户端按 1M 计算，但该模型的真实窗口未声明也未"
                    "探测到。上游若更小，会话不会自动压缩而是被上游拒绝。请声明 "
                    "claude1_capabilities.context_window",
                )
            )
            return ContextPlan(
                model_out=with_suffix(bare),
                window=ONE_M,
                source=SOURCE_SUFFIX,
                notes=tuple(notes),
            )
        notes.append(
            ContextNote(
                WARN_WINDOW_UNDECLARED,
                f"{bare} 的真实窗口未知，Claude Code 会按 "
                f"{DEFAULT_UNKNOWN_WINDOW} token 压缩。声明 "
                "claude1_capabilities.context_window 可得到准确窗口",
            )
        )
        return ContextPlan(
            model_out=bare,
            window=DEFAULT_UNKNOWN_WINDOW,
            source=SOURCE_ASSUMED,
            notes=tuple(notes),
        )

    if requested_suffix and window < ONE_M:
        notes.append(
            ContextNote(
                WARN_FAKE_1M,
                f"{bare}[1m] 让客户端按 1M 计算，但真实窗口是 {window} token；"
                f"已去掉后缀并改用 {MAX_CONTEXT_TOKENS_ENV}={window}",
            )
        )
    elif requested_suffix:
        notes.append(
            ContextNote(
                WARN_REDUNDANT_SUFFIX,
                f"{bare} 的真实窗口已是 {window} token，[1m] 后缀多余；"
                f"改用 {MAX_CONTEXT_TOKENS_ENV} 表达同一事实且不污染模型 ID",
            )
        )

    return ContextPlan(
        model_out=bare,
        window=window,
        source=source,
        env={MAX_CONTEXT_TOKENS_ENV: str(window)},
        notes=tuple(notes),
    )


def declared_window_from_settings(settings_config: object) -> int | None:
    """Read ``claude1_capabilities.context_window`` from a provider record.

    Tolerates every shape a hand-edited provider can hold; an unusable value is
    simply absent rather than an error, matching the repository's default-allow
    rule for data it did not write.
    """
    if not isinstance(settings_config, dict):
        return None
    capabilities = settings_config.get("claude1_capabilities")
    if not isinstance(capabilities, dict):
        return None
    return positive_int(capabilities.get("context_window"))


def positive_int(value: object) -> int | None:
    """Coerce a hand-written or upstream-supplied count, or return ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        try:
            parsed = int(value.strip(), 10)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def format_window(window: int) -> str:
    """Render a window the way the CLI's own notices do."""
    if window >= ONE_M and window % ONE_M == 0:
        return f"{window // ONE_M}M"
    if window >= 1000 and window % 1000 == 0:
        return f"{window // 1000}k"
    return str(window)
