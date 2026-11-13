#!/usr/bin/env bash
# Runs a command in a clean environment with HOME, agent directories and temp paths redirected
# to a fresh directory, so daemon and client tests cannot reach the developer's daemon, sessions,
# settings or credential environment variables.
# Usage: scripts/test-isolated.sh pnpm --filter @felan-ai/daemon test
set -euo pipefail
kernel="$(uname -s)"
case "$kernel" in
  MINGW*|MSYS*) root="$(mktemp -d)" ;;
  *)
    # Short root under /tmp keeps Unix socket paths below the macOS 104-byte limit.
    root="$(mktemp -d /tmp/fth.XXXXXX)"
    ;;
esac
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/tmp" "$root/.felan" "$root/.config" "$root/.cache" "$root/.local/share" "$root/run"
chmod 700 "$root" "$root/run"
isolated_root="$root"
environment=("PATH=$PATH")
case "$kernel" in
  MINGW*|MSYS*)
    isolated_root="$(cygpath -w "$root")"
    mkdir -p "$root/AppData/Roaming" "$root/AppData/Local"
    while IFS='=' read -r name value; do
      case "${name^^}" in
        SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROGRAMFILES|'PROGRAMFILES(X86)'|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)
          environment+=("$name=$value")
          ;;
      esac
    done < <(env)
    environment+=(
      "USERPROFILE=$isolated_root"
      "APPDATA=$(cygpath -w "$root/AppData/Roaming")"
      "LOCALAPPDATA=$(cygpath -w "$root/AppData/Local")"
      "TEMP=$(cygpath -w "$root/tmp")"
      "TMP=$(cygpath -w "$root/tmp")"
    )
    ;;
esac
# Resolve the pnpm store before HOME changes so pack/install steps keep using the real store.
store="$(pnpm store path 2>/dev/null || true)"
# Keep corepack's package-manager cache too; otherwise every run downloads pnpm again.
corepack_home="${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"
# Keep the shell alive so its EXIT trap runs after the command finishes.
env -i \
  "${environment[@]}" \
  LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" SHELL="${SHELL:-/bin/bash}" USER="${USER:-}" \
  HOME="$isolated_root" TMPDIR="$isolated_root/tmp" \
  FELAN_AGENT_DIR="$isolated_root/.felan" PI_CODING_AGENT_DIR="$isolated_root/.felan/agent" \
  XDG_CONFIG_HOME="$isolated_root/.config" XDG_CACHE_HOME="$isolated_root/.cache" XDG_DATA_HOME="$isolated_root/.local/share" XDG_RUNTIME_DIR="$isolated_root/run" \
  PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 FELAN_SKIP_VERSION_CHECK=1 CI=1 \
  ${store:+npm_config_store_dir="$store"} ${PNPM_HOME:+PNPM_HOME="$PNPM_HOME"} COREPACK_HOME="$corepack_home" \
  "$@"
