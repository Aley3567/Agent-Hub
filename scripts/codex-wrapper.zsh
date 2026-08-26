#!/usr/bin/env zsh

# A stale CODEX_HOME (for example, a removed codex1 shadow directory) makes
# Codex show the official login picker even when ~/.codex is authenticated.
# Accept an inherited home only when both live auth files are present.
local candidate="${CODEX_HOME:-$HOME/.codex}"
if [[ ! -f "$candidate/config.toml" || ! -f "$candidate/auth.json" ]]; then
  candidate="$HOME/.codex"
fi
export CODEX_HOME="$candidate"

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"

if nc -z -G 1 127.0.0.1 7897 >/dev/null 2>&1; then
  export HTTP_PROXY="http://127.0.0.1:7897"
  export HTTPS_PROXY="http://127.0.0.1:7897"
  export ALL_PROXY="http://127.0.0.1:7897"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTPS_PROXY"
  export all_proxy="$ALL_PROXY"
fi

local codex_bin="${CODEX_WRAPPER_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex}"
if [[ ! -x "$codex_bin" ]]; then
  print -u2 -- "[codex] Codex CLI 不可执行: $codex_bin"
  exit 127
fi
exec "$codex_bin" "$@"
