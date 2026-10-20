# ADR 0037: Retain the Linux PTY slave through output drain

Status: Accepted
Date: 2026-10-12

## Context

The pinned Linux PTY backend can report process completion after dropping the
last output bytes. An isolated native reproduction lost output in 4 of 48
concurrent runs. Holding a second slave descriptor preserved every byte in all
48 comparison runs. Transport, coordinator and persisted-log measurements
localized the loss below the extension layer.

This matches the upstream teardown issue discussed in
[node-pty #85](https://github.com/microsoft/node-pty/issues/85) and
[#72](https://github.com/microsoft/node-pty/issues/72). A package-only upgrade
does not supply a verified fix. The Node.js 22.20.0 pin remains unchanged.

## Decision

The local HostAgentRuntime adapter retains an owned Linux slave descriptor
until the pinned backend closes the master and emits exit. It then releases
the descriptor before reporting completion. Startup failure and disposal also
release it. The guard validates the pinned backend's private slave path,
requires an owned character device, refuses symlinks and opens without acquiring
a controlling terminal. Node opens the descriptor close-on-exec.

This is confined to the Linux host adapter. It introduces no portable service,
protocol or extension API and does not alter other platforms. Unsupported
backend path shapes fail closed instead of silently restoring data loss.

## Alternatives

- **Upgrade node-pty:** the examined next beta retains the relevant Unix
  teardown behavior; a version bump alone is not evidence of a correction.
- **Wait for a runtime/libuv correction:** preferable eventually, but no tested
  correction is available within the required Node pin.
- **Add sleeps, weaken output assertions or serialize the suite:** these would
  hide the failure instead of correcting the transport lifetime.
- **Replace the backend:** substantially more integration and platform risk
  than this contained lifetime guard.

## Consequences

The guard relies on a private path in the exactly pinned dependency. Dependency
upgrades must run the output-integrity, ownership and descriptor-cleanup tests.
Normal Linux PTY completion uses the backend's existing roughly 200 ms close
fallback; no application sleep is introduced. The bounded upstream close
policy still applies under extreme event-loop starvation.

Remove the guard only after a supported backend/runtime correction passes the
same unguarded reproduction and public-runtime regression coverage. Retained
diagnostic controls and results are in the Story 1 verification artifacts.
