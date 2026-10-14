#!/usr/bin/env bash
# Runs a command in a clean environment with HOME, agent directories and temp paths redirected
# to a fresh directory, so daemon and client tests cannot reach the developer's daemon, sessions,
# settings or credential environment variables.
# Usage: scripts/test-isolated.sh pnpm --filter @felan-ai/daemon test
set -euo pipefail
# Short root under /tmp keeps Unix socket paths below the macOS 104-byte limit.
root="$(mktemp -d /tmp/fth.XXXXXX)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/tmp" "$root/.felan" "$root/.config" "$root/.cache" "$root/.local/share" "$root/run"
chmod 700 "$root" "$root/run"
# Resolve the pnpm store before HOME changes so pack/install steps keep using the real store.
store="$(pnpm store path 2>/dev/null || true)"
exec env -i \
  PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" SHELL="${SHELL:-/bin/bash}" USER="${USER:-}" \
  HOME="$root" TMPDIR="$root/tmp" \
  FELAN_AGENT_DIR="$root/.felan" PI_CODING_AGENT_DIR="$root/.felan/agent" \
  XDG_CONFIG_HOME="$root/.config" XDG_CACHE_HOME="$root/.cache" XDG_DATA_HOME="$root/.local/share" XDG_RUNTIME_DIR="$root/run" \
  PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 FELAN_SKIP_VERSION_CHECK=1 CI=1 \
  ${store:+npm_config_store_dir="$store"} ${PNPM_HOME:+PNPM_HOME="$PNPM_HOME"} \
  "$@"
